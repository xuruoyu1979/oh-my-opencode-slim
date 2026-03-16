import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundTaskManager } from '../background';
import type { PluginConfig } from '../config';
import { SUBAGENT_NAMES } from '../config';
import type { TmuxConfig } from '../config/schema';

const z = tool.schema;

/**
 * Creates background task management tools for the plugin.
 * @param _ctx - Plugin input context
 * @param manager - Background task manager for launching and tracking tasks
 * @param _tmuxConfig - Optional tmux configuration for session management
 * @param _pluginConfig - Optional plugin configuration for agent variants
 * @returns Object containing background_task, background_output, and background_cancel tools
 */
export function createBackgroundTools(
  _ctx: PluginInput,
  manager: BackgroundTaskManager,
  _tmuxConfig?: TmuxConfig,
  _pluginConfig?: PluginConfig,
): Record<string, ToolDefinition> {
  const agentNames = SUBAGENT_NAMES.join(', ');

  // Tool for launching agent tasks (fire-and-forget)
  const background_task = tool({
    description: `Launch background agent task. Returns task_id immediately.

Flow: launch → wait for automatic notification when complete.

Key behaviors:
- Fire-and-forget: returns task_id in ~1ms
- Parallel: up to 10 concurrent tasks
- Auto-notify: parent session receives result when task completes`,

    args: {
      description: z
        .string()
        .describe('Short description of the task (5-10 words)'),
      prompt: z.string().describe('The task prompt for the agent'),
      agent: z.string().describe(`Agent to use: ${agentNames}`),
    },
    async execute(args, toolContext) {
      if (
        !toolContext ||
        typeof toolContext !== 'object' ||
        !('sessionID' in toolContext)
      ) {
        throw new Error('Invalid toolContext: missing sessionID');
      }

      const agent = String(args.agent);
      const prompt = String(args.prompt);
      const description = String(args.description);
      const parentSessionId = (toolContext as { sessionID: string }).sessionID;

      // Validate agent against delegation rules
      if (!manager.isAgentAllowed(parentSessionId, agent)) {
        const allowed = manager.getAllowedSubagents(parentSessionId);
        return `Agent '${agent}' is not allowed. Allowed agents: ${allowed.join(', ')}`;
      }

      // Fire-and-forget launch
      const task = manager.launch({
        agent,
        prompt,
        description,
        parentSessionId,
      });

      return `Background task launched.

Task ID: ${task.id}
Agent: ${agent}
Status: ${task.status}

Use \`background_output\` with task_id="${task.id}" to get results.`;
    },
  });

  // Tool for retrieving output from background tasks
  const background_output = tool({
    description: `Get background task results after completion notification received.

timeout=0: returns status immediately (no wait)
timeout=N: waits up to N ms for completion

Returns: results if completed, error if failed, status if running.`,

    args: {
      task_id: z.string().describe('Task ID from background_task'),
      timeout: z
        .number()
        .optional()
        .describe('Wait for completion (in ms, 0=no wait, default: 0)'),
    },
    async execute(args) {
      const taskId = String(args.task_id);
      const timeout =
        typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : 0;

      let task = manager.getResult(taskId);

      // Wait for completion if timeout specified
      if (
        task &&
        timeout > 0 &&
        task.status !== 'completed' &&
        task.status !== 'failed' &&
        task.status !== 'cancelled'
      ) {
        task = await manager.waitForCompletion(taskId, timeout);
      }

      if (!task) {
        return `Task not found: ${taskId}`;
      }

      // Calculate task duration
      const duration = task.completedAt
        ? `${Math.floor((task.completedAt.getTime() - task.startedAt.getTime()) / 1000)}s`
        : `${Math.floor((Date.now() - task.startedAt.getTime()) / 1000)}s`;

      let output = `Task: ${task.id}
 Description: ${task.description}
 Status: ${task.status}
 Duration: ${duration}

 ---

 `;

      // Include task result or error based on status
      if (task.status === 'completed' && task.result != null) {
        output += task.result;
      } else if (task.status === 'failed') {
        output += `Error: ${task.error}`;
      } else if (task.status === 'cancelled') {
        output += '(Task cancelled)';
      } else {
        output += '(Task still running)';
      }

      return output;
    },
  });

  // Tool for canceling running background tasks
  const background_cancel = tool({
    description: `Cancel background task(s).

task_id: cancel specific task
all=true: cancel all running tasks

Only cancels pending/starting/running tasks.`,
    args: {
      task_id: z.string().optional().describe('Specific task to cancel'),
      all: z.boolean().optional().describe('Cancel all running tasks'),
    },
    async execute(args) {
      // Cancel all running tasks if requested
      if (args.all === true) {
        const count = manager.cancel();
        return `Cancelled ${count} task(s).`;
      }

      // Cancel specific task if task_id provided
      if (typeof args.task_id === 'string') {
        const count = manager.cancel(args.task_id);
        return count > 0
          ? `Cancelled task ${args.task_id}.`
          : `Task ${args.task_id} not found or not running.`;
      }

      return 'Specify task_id or use all=true.';
    },
  });

  // Tool for listing background tasks
  const background_list = tool({
    description: `List all background tasks with optional status filtering.

Returns a table of tasks showing ID, agent, description, status, and duration.
Use status filter to see only pending, running, completed, failed, or cancelled tasks.`,
    args: {
      status: z
        .enum([
          'pending',
          'starting',
          'running',
          'completed',
          'failed',
          'cancelled',
        ])
        .optional()
        .describe('Filter by status (optional)'),
    },
    async execute(args) {
      const statusFilter = args.status as
        | 'pending'
        | 'starting'
        | 'running'
        | 'completed'
        | 'failed'
        | 'cancelled'
        | undefined;

      const tasks = manager.listTasks(statusFilter);

      if (tasks.length === 0) {
        return statusFilter
          ? `No background tasks with status "${statusFilter}".`
          : 'No background tasks found.';
      }

      // Format duration helper
      const formatDuration = (ms: number): string => {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        return `${minutes}m ${seconds}s`;
      };

      // Build table output
      const lines: string[] = [
        `Found ${tasks.length} background task(s):`,
        '',
        'ID | Agent | Description | Status | Duration',
        '---|-------|-------------|--------|----------',
      ];

      for (const task of tasks) {
        const shortId = task.id.slice(0, 12);
        const desc =
          task.description.length > 30
            ? task.description.slice(0, 27) + '...'
            : task.description;
        const duration = formatDuration(task.durationMs);
        lines.push(
          `${shortId} | ${task.agent} | ${desc} | ${task.status} | ${duration}`,
        );
      }

      return lines.join('\n');
    },
  });

  return {
    background_task,
    background_output,
    background_cancel,
    background_list,
  };
}
