import { Context } from 'hono';
import { map } from 'lodash-es'
import { giteaService, PullRequestFile, PullRequestDetails } from '../services/gitea';
import { aiReviewService } from '../services/ai-review';
import { feishuService } from '../services/feishu';
import config from '../config';
import * as crypto from 'crypto';
import { logger } from '../utils/logger';

// 判断是否为开发环境
const isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;

// Gitea webhook事件类型
enum GiteaEventType {
  PullRequest = 'pull_request',
  Status = 'status',
  Issue = 'issues',
  Unknown = 'unknown'
}

/**
 * 验证Webhook请求签名
 */
function verifyWebhookSignature(body: string, signature: string): boolean {
  // 开发环境下跳过签名验证
  if (isDev && !signature) {
    logger.warn('开发环境: 跳过Webhook签名验证');
    return true;
  }

  if (!config.app.webhookSecret) {
    logger.warn('未配置Webhook密钥，跳过签名验证');
    return false;
  }

  // Gitea使用SHA-256哈希算法
  const hmac = crypto.createHmac('sha256', config.app.webhookSecret);
  hmac.update(body);
  const calculatedSignature = hmac.digest('hex');

  // 如果签名不存在，直接返回false
  if (!signature) {
    logger.warn('请求中无签名头');
    return false;
  }

  // Gitea的签名没有前缀，直接比较
  try {
    // 使用timingSafeEqual进行常量时间比较，防止时序攻击
    return crypto.timingSafeEqual(
      Buffer.from(calculatedSignature),
      Buffer.from(signature)
    );
  } catch (error) {
    logger.error('签名验证失败', error);
    return false;
  }
}

/**
 * 确定Gitea Webhook事件类型
 */
function determineEventType(c: Context, body: any): GiteaEventType {
  // 优先从请求头获取事件类型
  const eventHeader = c.req.header('X-Gitea-Event');
  if (eventHeader) {
    if (eventHeader === 'pull_request') return GiteaEventType.PullRequest;
    if (eventHeader === 'status') return GiteaEventType.Status;
    if (eventHeader === 'issues') return GiteaEventType.Issue;
  }

  // 如果没有事件头，尝试从请求体判断
  if (body.pull_request) return GiteaEventType.PullRequest;
  if (body.state && (body.sha || body.commit)) return GiteaEventType.Status;
  if (body.issue) return GiteaEventType.Issue;

  // 无法确定事件类型
  return GiteaEventType.Unknown;
}

/**
 * 处理Pull Request事件
 */
async function handlePullRequestEvent(c: Context, body: any): Promise<Response> {
  // 仅处理PR打开或更新事件
  if (
    body.action !== 'opened' &&
    body.action !== 'reopened' &&
    body.action !== 'synchronize' &&
    body.action !== 'edited' &&
    body.action !== 'review_requested'
  ) {
    return c.json({ status: 'ignored', message: '无需处理的事件类型' }, 200);
  }

  // 从事件中提取必要信息
  const {
    pull_request: pullRequest,
    repository: repo
  } = body;

  if (!pullRequest || !repo) {
    return c.json({ error: '无效的Webhook数据' }, 400);
  }

  const prNumber = pullRequest.number;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const prTitle = pullRequest.title;
  const prUrl = pullRequest.html_url;

  logger.info(`收到PR事件`, { owner, repo: repoName, prNumber, action: body.action });

  // 处理PR审阅者通知
  try {
    // 获取PR的审阅者列表
    const reviewerUsernames = map(pullRequest.requested_reviewers, reviewer => reviewer.full_name || reviewer.login);

    // 记录审阅者信息
    if (reviewerUsernames.length > 0) {
      logger.info(`PR有指定审阅者`, {
        prNumber,
        reviewers: reviewerUsernames.join(',')
      });
    }

    // 处理PR创建事件，如果有审阅者，则通知
    if (body.action === 'opened' && reviewerUsernames.length > 0) {
      await feishuService.sendPrCreatedNotification(prTitle, prUrl, reviewerUsernames);
    }

    // 处理审阅者指派事件
    if (body.action === 'review_requested' && body.requested_reviewer) {
      const newReviewerUsername = body.requested_reviewer.full_name || body.requested_reviewer.login;
      if (newReviewerUsername) {
        await feishuService.sendPrReviewerAssignedNotification(prTitle, prUrl, [newReviewerUsername]);
      }
    }
  } catch (error) {
    logger.error(`处理PR审阅者通知失败:`, error);
    // 继续执行代码审查流程，不因通知失败而中断
  }

  // 开始异步审查流程
  reviewPullRequest(owner, repoName, prNumber).catch(error => {
    logger.error(`审查PR ${owner}/${repoName}#${prNumber} 失败:`, error);
  });

  // 立即返回以不阻塞Webhook
  return c.json({ status: 'accepted', message: '代码审查请求已接受' }, 202);
}

/**
 * 处理提交状态更新事件
 */
async function handleCommitStatusEvent(c: Context, body: any): Promise<Response> {
  // 记录收到的数据，方便调试
  logger.debug('收到提交状态webhook数据', {
    state: body.state,
    sha: body.sha,
    commit_id: body.commit?.id,
    context: body.context,
    repo: body.repository?.full_name
  });

  // 验证请求体中是否包含必要信息
  if (!body.commit || !body.repository || !body.state) {
    logger.error('无效的Webhook数据', { body: JSON.stringify(body).substring(0, 500) });
    return c.json({ error: '无效的Webhook数据' }, 400);
  }

  // 只处理成功状态的提交
  if (body.state !== 'success') {
    return c.json({ status: 'ignored', message: `忽略非成功状态的提交: ${body.state}` }, 200);
  }

  // 获取关键信息
  const commitSha = body.sha || body.commit.id; // 兼容不同版本的Gitea
  const owner = body.repository.owner.login;
  const repoName = body.repository.name;

  // 检查提交是否与PR相关
  let relatedPR: PullRequestDetails | null = null;
  try {
    relatedPR = await giteaService.getRelatedPullRequest(owner, repoName, commitSha);
    if (!relatedPR) {
      logger.info(`提交 ${commitSha} 不与任何PR关联，跳过审查`);
      return c.json({ status: 'ignored', message: '提交不与任何PR关联' }, 200);
    }
    logger.info(`提交 ${commitSha} 关联到PR #${relatedPR.number}`);
  } catch (error) {
    logger.warn(`检查提交 ${commitSha} 是否与PR关联时出错`, error);
    // 继续处理，因为有可能API临时错误，但提交仍需审查
  }

  // 提取commit信息
  const commitInfo = {
    sha: commitSha,
    message: body.commit.message || '',
    added: body.commit.added || [],
    removed: body.commit.removed || [],
    modified: body.commit.modified || []
  };

  logger.info(`收到提交状态更新事件`, {
    owner,
    repo: repoName,
    commitSha,
    state: body.state,
    relatedPR: relatedPR?.number || 'unknown',
    added: commitInfo.added.length,
    modified: commitInfo.modified.length,
    removed: commitInfo.removed.length
  });

  // 如果没有文件变更信息，则忽略
  if (commitInfo.added.length === 0 && commitInfo.modified.length === 0 && commitInfo.removed.length === 0) {
    logger.warn('提交没有文件变更信息，忽略审查', { commitSha });
    return c.json({ status: 'ignored', message: '提交没有文件变更信息' }, 200);
  }

  // 开始异步审查流程，传入关联的PR信息
  reviewCommit(owner, repoName, commitSha, commitInfo, relatedPR).catch(error => {
    logger.error(`审查提交 ${owner}/${repoName}@${commitSha} 失败:`, error);
  });

  // 立即返回以不阻塞Webhook
  return c.json({ status: 'accepted', message: '提交代码审查请求已接受' }, 202);
}

/**
 * 处理工单事件
 */
async function handleIssueEvent(c: Context, body: any): Promise<Response> {
  const { action, issue, repository } = body;

  if (!issue || !repository) {
    return c.json({ error: '无效的Webhook数据' }, 400);
  }

  const issueTitle = issue.title;
  const issueUrl = issue.html_url;
  const creatorUsername = issue.user.full_name || issue.user.login;
  const assigneeUsernames = map(issue.assignees, assignee => assignee.full_name || assignee.login);

  logger.info(`收到工单事件`, {
    action,
    issueTitle,
    issueUrl,
    creatorUsername,
    assigneeUsernames: assigneeUsernames.join(',')
  });

  try {
    // 处理工单创建事件
    if (action === 'opened' && assigneeUsernames.length > 0) {
      await feishuService.sendIssueCreatedNotification(issueTitle, issueUrl, assigneeUsernames);
    }
    // 处理工单关闭事件
    else if (action === 'closed' && creatorUsername) {
      await feishuService.sendIssueClosedNotification(issueTitle, issueUrl, creatorUsername);
    }
    // 处理工单指派事件
    else if (action === 'assigned' && assigneeUsernames.length > 0) {
      await feishuService.sendIssueAssignedNotification(issueTitle, issueUrl, assigneeUsernames);
    }
  } catch (error) {
    logger.error('处理工单事件失败:', error);
    return c.json({ error: '处理工单事件失败' }, 500);
  }

  return c.json({ status: 'success', message: '工单事件处理完成' }, 200);
}

/**
 * 审查Pull Request的代码
 */
async function reviewPullRequest(owner: string, repo: string, prNumber: number): Promise<void> {
  try {
    logger.info(`开始审查PR ${owner}/${repo}#${prNumber}`);

    // 如果是开发环境，模拟PR差异和详情
    let prDetails;
    let diffContent;

    if (isDev) {
      // 开发环境中的测试数据
      logger.info('开发环境: 使用测试数据');
      prDetails = {
        id: prNumber,
        number: prNumber,
        title: '测试PR',
        head: {
          sha: 'abcd1234abcd1234abcd1234abcd1234abcd1234'
        },
        base: {
          repo: {
            owner: {
              login: owner
            },
            name: repo
          }
        }
      };

      // 测试用diff内容
      diffContent = `diff --git a/test.js b/test.js
index 1234567..abcdefg 100644
--- a/test.js
+++ b/test.js
@@ -1,5 +1,9 @@
 function add(a, b) {
-  return a + b;
+  return a + b; // 简单的加法函数
 }

-console.log(add(1, 2));
+// 不安全的数据处理
+function processUserData(data) {
+  eval(data); // 这里有安全问题
+}
+console.log(add(1, 2));`;
    } else {
      // 生产环境中从Gitea获取真实数据
      [prDetails, diffContent] = await Promise.all([
        giteaService.getPullRequestDetails(owner, repo, prNumber),
        giteaService.getPullRequestDiff(owner, repo, prNumber)
      ]);
    }

    // 提取commit SHA
    const commitId = prDetails.head.sha;

    // 使用增强的AI代码审查服务
    const reviewResult = await aiReviewService.reviewCode(
      owner,
      repo,
      prNumber,
      diffContent,
      commitId
    );

    logger.info('代码审查结果', {
      summary: reviewResult.summary.substring(0, 100) + '...',
      commentCount: reviewResult.lineComments.length
    });

    // 添加总结评论
    if (isDev) {
      logger.info('开发环境: 模拟添加PR评论', {
        comment: reviewResult.summary
      });
    } else {
      logger.info('生产环境: 添加PR评论', {
        owner,
        repo,
        prNumber,
        comment: reviewResult.summary
      });
      await giteaService.addPullRequestComment(
        owner,
        repo,
        prNumber,
        `## AI代码审查结果\n\n${reviewResult.summary}`
      );
    }

    // 添加行级评论
    if (reviewResult.lineComments.length > 0) {
      if (isDev) {
        logger.info('开发环境: 模拟添加行评论', {
          commentCount: reviewResult.lineComments.length,
          comments: reviewResult.lineComments
        });
      } else {
        await giteaService.addLineComments(
          owner,
          repo,
          prNumber,
          commitId,
          reviewResult.lineComments
        );
      }
    }

    logger.info(`完成PR ${owner}/${repo}#${prNumber} 的代码审查`);
  } catch (error) {
    logger.error(`审查PR失败:`, error);
    throw error;
  }
}

/**
 * 审查提交的代码变更
 */
async function reviewCommit(
  owner: string,
  repo: string,
  commitSha: string,
  commitInfo: {
    sha: string,
    message: string,
    added: string[],
    modified: string[],
    removed: string[]
  },
  relatedPR?: PullRequestDetails | null
): Promise<void> {
  try {
    logger.info(`开始审查提交 ${owner}/${repo}@${commitSha}`);
    logger.info('提交信息', {
      message: commitInfo.message.substring(0, 100) + (commitInfo.message.length > 100 ? '...' : ''),
      added: commitInfo.added.length,
      modified: commitInfo.modified.length,
      removed: commitInfo.removed.length
    });

    // 如果是开发环境，打印更多信息但不执行实际审查
    if (isDev) {
      logger.info('开发环境: 正在模拟审查提交', {
        owner,
        repo,
        commitSha,
        added: commitInfo.added,
        modified: commitInfo.modified,
        removed: commitInfo.removed
      });
      return;
    }

    // 创建自定义文件列表，因为Gitea API不直接提供
    const webhookFiles: PullRequestFile[] = [
      ...commitInfo.added.map(filename => ({
        filename,
        status: 'added',
        additions: 0, // 不知道具体行数
        deletions: 0,
        changes: 0
      })),
      ...commitInfo.modified.map(filename => ({
        filename,
        status: 'modified',
        additions: 0,
        deletions: 0,
        changes: 0
      })),
      ...commitInfo.removed.map(filename => ({
        filename,
        status: 'removed',
        additions: 0,
        deletions: 0,
        changes: 0
      }))
    ];

    // 使用AI审查服务分析提交，并传入webhook提供的文件列表
    const reviewResult = await aiReviewService.reviewCommit(
      owner,
      repo,
      commitSha,
      webhookFiles
    );

    logger.info('提交代码审查结果', {
      summary: reviewResult.summary.substring(0, 100) + '...',
      commentCount: reviewResult.lineComments.length
    });

    // 添加总结评论到提交
    try {
      await giteaService.addCommitComment(
        owner,
        repo,
        commitSha,
        `## AI代码审查结果\n\n${reviewResult.summary}`
      );
    } catch (error) {
      logger.error('添加提交评论失败:', error);
      // 继续处理，尝试添加到PR
    }

    // 尝试使用传入的PR信息，或者查找相关的PR
    try {
      // 如果已经有关联PR，直接使用
      if (relatedPR && relatedPR.number) {
        logger.info(`使用已知关联的PR #${relatedPR.number}`);

        // 添加行级评论
        if (reviewResult.lineComments.length > 0) {
          await giteaService.addLineComments(
            owner,
            repo,
            relatedPR.number,
            commitSha,
            reviewResult.lineComments
          );
        }
      } else {
        // 否则尝试查找
        logger.info('尝试查找与提交关联的PR');
        const response = await giteaService.getRelatedPullRequest(owner, repo, commitSha);
        if (response && response.number) {
          logger.info(`找到与提交关联的PR #${response.number}`);

          // 添加行级评论
          if (reviewResult.lineComments.length > 0) {
            await giteaService.addLineComments(
              owner,
              repo,
              response.number,
              commitSha,
              reviewResult.lineComments
            );
          }
        } else {
          logger.info('未找到与提交关联的PR，无法添加行级评论');
        }
      }
    } catch (error) {
      logger.warn('处理PR关联失败，将跳过行级评论', error);
    }

    logger.info(`完成提交 ${owner}/${repo}@${commitSha} 的代码审查`);
  } catch (error) {
    logger.error(`审查提交失败:`, error);
    throw error;
  }
}

/**
 * 统一处理Gitea Webhook事件
 */
export async function handleGiteaWebhook(c: Context): Promise<Response> {
  try {
    // 验证Webhook签名
    const signature = c.req.header('X-Gitea-Signature') || '';
    const rawBody = await c.req.text();

    if (!verifyWebhookSignature(rawBody, signature)) {
      logger.error('Webhook签名验证失败');
      return c.json({ error: 'Webhook签名验证失败' }, 401);
    }

    // 解析请求体
    const body = JSON.parse(rawBody);

    // 确定事件类型
    const eventType = determineEventType(c, body);
    logger.info(`收到Gitea Webhook事件: ${eventType}`);

    // 根据事件类型路由到相应的处理逻辑
    switch (eventType) {
      case GiteaEventType.PullRequest:
        return await handlePullRequestEvent(c, body);
      case GiteaEventType.Status:
        return await handleCommitStatusEvent(c, body);
      case GiteaEventType.Issue:
        return await handleIssueEvent(c, body);
      default:
        logger.warn(`未支持的Webhook事件类型: ${eventType}`);
        return c.json({ status: 'ignored', message: '未支持的Webhook事件类型' }, 200);
    }
  } catch (error) {
    logger.error('处理Gitea Webhook事件失败:', error);
    return c.json({ error: '处理Gitea Webhook事件失败' }, 500);
  }
}
