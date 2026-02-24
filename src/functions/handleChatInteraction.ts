import type { Request, Response } from 'express';
import {
  getPendingTasks,
  updateTaskDetails,
  markTaskAsCreated,
  markTaskAsDismissed,
  updatePendingTasksStatus,
  getUserPendingTasks,
  getPendingTasksStats
} from '../services/firestoreService.js';
import { createTask, getListDetails } from '../services/clickupService.js';
import { cacheDMSpace } from '../services/chatService.js';
import { getAllFolderConfigs } from '../utils/folderConfigResolver.js';
import { getChatFunctionUrl } from '../config/index.js';
import type { ChatCardInteraction, TaskPriority } from '../types/index.js';

/**
 * Wrap a message in the Google Workspace Add-ons response format.
 * This is required when the Chat app is configured as a Workspace Add-on.
 */
function wrapResponse(message: { text?: string; cardsV2?: any[] }): object {
  return {
    hostAppDataAction: {
      chatDataAction: {
        createMessageAction: {
          message
        }
      }
    }
  };
}

/**
 * Cloud Function that handles Google Chat webhook interactions.
 */
export async function handleChatInteraction(
  req: Request,
  res: Response
): Promise<void> {
  // Log the full request body for debugging
  console.log('Request body:', JSON.stringify(req.body));

  const body = req.body;

  // Handle the new Google Workspace Add-ons format (nested under 'chat')
  // Message events: chat.messagePayload.message
  // Button clicks: chat.buttonClickedPayload + commonEventObject.parameters
  const chatData = body.chat || body;
  const messagePayload = chatData.messagePayload || {};
  const buttonClickedPayload = chatData.buttonClickedPayload || {};
  const message = messagePayload.message || body.message;
  const space = messagePayload.space || buttonClickedPayload.space || body.space;
  const user = chatData.user || body.user;
  const action = body.action || chatData.action;
  const commonEventObject = body.commonEventObject || body.common || {};

  // Determine event type from the payload structure
  let eventType: string;
  if (body.type) {
    // Old format with explicit type
    eventType = body.type;
  } else if (buttonClickedPayload.message || commonEventObject.parameters?.actionName) {
    // Workspace Add-ons button click - has buttonClickedPayload or parameters with actionName
    eventType = 'CARD_CLICKED';
  } else if (action) {
    // Card button clicked (old format)
    eventType = 'CARD_CLICKED';
  } else if (message) {
    // Message received
    eventType = 'MESSAGE';
  } else if (space && !message) {
    // Added to space (no message, just space info)
    eventType = 'ADDED_TO_SPACE';
  } else {
    eventType = 'UNKNOWN';
  }

  console.log(`Detected Chat event type: ${eventType}`);

  // Build a normalized event object
  // For Workspace Add-ons, action parameters are in commonEventObject.parameters
  const event: ChatCardInteraction = {
    type: eventType,
    message: message,
    space: space,
    user: user,
    action: action || (commonEventObject.parameters ? { parameters: Object.entries(commonEventObject.parameters).map(([key, value]) => ({ key, value })) } : undefined),
    common: commonEventObject
  };

  try {
    switch (eventType) {
      case 'ADDED_TO_SPACE':
        await handleAddedToSpace(event, res);
        break;

      case 'REMOVED_FROM_SPACE':
        console.log('Bot removed from space');
        res.setHeader('Content-Type', 'application/json');
        res.status(200).json({});
        break;

      case 'MESSAGE':
        await handleMessage(event, res);
        break;

      case 'CARD_CLICKED':
        await handleCardClick(event, res);
        break;

      default:
        console.log(`Unknown event type: ${eventType}`);
        res.setHeader('Content-Type', 'application/json');
        res.status(200).json(wrapResponse({ text: 'Hello! Type `help` for assistance.' }));
    }
  } catch (error) {
    console.error('Error handling chat interaction:', error);
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(wrapResponse({ text: 'An error occurred. Please try again.' }));
  }
}

/**
 * Handle bot added to space.
 */
async function handleAddedToSpace(
  event: ChatCardInteraction,
  res: Response
): Promise<void> {
  // Cache the DM space mapping
  const userEmail = event.user?.email || '';
  const spaceName = event.space?.name || '';
  if (userEmail && spaceName) {
    cacheDMSpace(userEmail, spaceName).catch(() => {});
  }

  const welcomeMessage = {
    text: `👋 Hello! I'm the Meeting Task Bot.\n\nI monitor meeting transcripts in configured Google Drive folders and extract tasks for you to review.\n\nWhen tasks are found, I'll send you approval cards where you can:\n• Edit task details\n• Assign team members\n• Set due dates and priorities\n• Create tasks in ClickUp with one click\n\nI'll start monitoring transcripts automatically!`
  };

  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(wrapResponse(welcomeMessage));
}

/**
 * Handle direct messages to the bot.
 */
async function handleMessage(
  event: ChatCardInteraction,
  res: Response
): Promise<void> {
  const messageText = event.message?.text?.toLowerCase() || '';
  const userEmail = event.user?.email || '';
  const spaceName = event.space?.name || '';

  // Cache the user's DM space so processTranscript can send them proactive DMs
  if (userEmail && spaceName) {
    cacheDMSpace(userEmail, spaceName).catch(() => {});
  }

  if (messageText.includes('help')) {
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(wrapResponse({
      text: `📚 *Meeting Task Bot Help*\n\n• I automatically process meeting transcripts from monitored Drive folders\n• Tasks are extracted using AI and sent to you for approval\n• Use the card buttons to create tasks in ClickUp\n\n*Commands:*\n• \`help\` - Show this message\n• \`status\` - Dashboard with folders & stats\n• \`tasks\` or \`pending\` - Show your pending tasks\n• \`recent\` - Show recently processed meetings`
    }));
    return;
  } else if (messageText.includes('status')) {
    await handleStatusCommand(res);
    return;
  } else if (messageText.includes('recent')) {
    await handleRecentCommand(res);
    return;
  } else if (messageText.includes('task') || messageText.includes('pending')) {
    // Show pending tasks for this user
    await showPendingTasks(userEmail, res);
    return;
  } else {
    // Default: show pending tasks if any, otherwise show welcome message
    const hasPending = await showPendingTasks(userEmail, res);
    if (!hasPending) {
      res.setHeader('Content-Type', 'application/json');
      res.status(200).json(wrapResponse({
        text: `👋 Hello! I process meeting transcripts automatically and extract tasks for you to review.\n\nType \`help\` for more information, or \`tasks\` to see your pending tasks.`
      }));
    }
    return;
  }
}

/**
 * Handle the status command - show monitoring dashboard.
 */
async function handleStatusCommand(res: Response): Promise<void> {
  try {
    const folders = getAllFolderConfigs();
    const stats = await getPendingTasksStats();

    const folderList = folders
      .map(f => `• 📁 *${f.name}* — prefix: \`${f.taskPrefix || '(none)'}\``)
      .join('\n');

    const statusText = [
      `✅ *Meeting Task Bot Status*`,
      ``,
      `*Monitored Folders (${folders.length}):*`,
      folderList,
      ``,
      `*Task Stats:*`,
      `• Pending review: ${stats.pending}`,
      `• In progress: ${stats.processing}`,
      `• Completed: ${stats.completed}`,
      `• Total processed: ${stats.total}`,
    ].join('\n');

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(wrapResponse({ text: statusText }));
  } catch (error) {
    console.error('Error in status command:', error);
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(wrapResponse({ text: '✅ Meeting Task Bot is running.' }));
  }
}

/**
 * Handle the recent command - show recently processed meetings.
 */
async function handleRecentCommand(res: Response): Promise<void> {
  try {
    // Get the most recent task sets (all statuses - pending, processing, completed)
    const pendingTasks = await getUserPendingTasks(10, true);

    if (!pendingTasks || pendingTasks.length === 0) {
      res.setHeader('Content-Type', 'application/json');
      res.status(200).json(wrapResponse({
        text: `📭 No recently processed meetings found.\n\nTranscripts will appear here after they are uploaded to a monitored Drive folder.`
      }));
      return;
    }

    const meetingLines = pendingTasks.map(ts => {
      const totalTasks = ts.tasks.length;
      const created = ts.tasks.filter((t: any) => t.clickupTaskId).length;
      const dismissed = ts.tasks.filter((t: any) => t.dismissed).length;
      const pending = totalTasks - created - dismissed;

      let statusEmoji = '⏳';
      if (pending === 0) statusEmoji = '✅';
      else if (created > 0 || dismissed > 0) statusEmoji = '🔄';

      return `${statusEmoji} *${ts.meetingInfo.title}*\n   📁 ${ts.folderConfig.name} • ${totalTasks} tasks (${created} created, ${dismissed} dismissed, ${pending} pending)`;
    });

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(wrapResponse({
      text: `📋 *Recent Meetings*\n\n${meetingLines.join('\n\n')}\n\nType \`tasks\` to review pending tasks.`
    }));
  } catch (error) {
    console.error('Error in recent command:', error);
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(wrapResponse({ text: '❌ Error loading recent meetings.' }));
  }
}

/**
 * Show pending tasks for a user.
 */
async function showPendingTasks(
  userEmail: string,
  res: Response
): Promise<boolean> {
  try {
    console.log('Fetching pending tasks...');
    // Get all pending tasks (we'll filter for recent ones)
    const pendingTasks = await getUserPendingTasks();
    console.log(`Found ${pendingTasks?.length || 0} pending task sets`);

    if (!pendingTasks || pendingTasks.length === 0) {
      return false;
    }

    // Find the first pending task set that has active (non-dismissed, non-created) tasks
    let mostRecent: (typeof pendingTasks)[0] | null = null;
    let activeTasks: any[] = [];

    for (const taskSet of pendingTasks) {
      const active = taskSet.tasks
        .map((t: any, originalIndex: number) => ({ ...t, _originalIndex: originalIndex }))
        .filter((t: any) => !t.dismissed && !t.clickupTaskId);

      if (active.length > 0) {
        mostRecent = taskSet;
        activeTasks = active;
        break;
      }
    }

    if (!mostRecent || activeTasks.length === 0) {
      console.log('All pending task sets have been fully resolved');
      return false;
    }

    console.log(`Building card for ${activeTasks.length} active tasks (${mostRecent.tasks.length} total)`);

    const FUNCTION_URL = getChatFunctionUrl();
    const cards: any[] = [];

    // Header card with meeting context
    const headerWidgets: any[] = [];

    if (mostRecent.analysis?.meeting_summary) {
      headerWidgets.push({
        decoratedText: {
          topLabel: 'Meeting Summary',
          text: mostRecent.analysis.meeting_summary,
          wrapText: true
        }
      });
    }

    if (mostRecent.analysis?.decisions && mostRecent.analysis.decisions.length > 0) {
      headerWidgets.push({
        decoratedText: {
          topLabel: 'Key Decisions',
          text: mostRecent.analysis.decisions.map((d: string) => `• ${d}`).join('\n'),
          wrapText: true
        }
      });
    }

    headerWidgets.push({
      decoratedText: {
        topLabel: 'Tasks Pending Review',
        text: `${activeTasks.length} task${activeTasks.length !== 1 ? 's' : ''} remaining out of ${mostRecent.tasks.length} total`
      }
    });

    cards.push({
      cardId: 'header',
      card: {
        header: {
          title: `📋 ${mostRecent.meetingInfo.title}`,
          subtitle: `📁 ${mostRecent.folderConfig.name}`
        },
        sections: [{ widgets: headerWidgets }]
      }
    });

    // Task cards with action buttons
    activeTasks.slice(0, 5).forEach((t: any) => {
      const i = t._originalIndex;
      cards.push({
        cardId: `task_${i}`,
        card: {
          header: {
            title: `Task ${i + 1}: ${t.title.substring(0, 40)}${t.title.length > 40 ? '...' : ''}`,
            subtitle: `Priority: ${t.priority} | ${t.suggested_assignee || 'Unassigned'}`
          },
          sections: [
            {
              widgets: [
                {
                  decoratedText: {
                    topLabel: 'Description',
                    text: t.description?.substring(0, 100) || t.title,
                    wrapText: true
                  }
                },
                {
                  buttonList: {
                    buttons: [
                      {
                        text: '✅ Create Task',
                        onClick: {
                          action: {
                            function: FUNCTION_URL,
                            parameters: [
                              { key: 'actionName', value: 'createTask' },
                              { key: 'pendingId', value: mostRecent!.id },
                              { key: 'taskIndex', value: i.toString() }
                            ]
                          }
                        }
                      },
                      {
                        text: '❌ Dismiss',
                        onClick: {
                          action: {
                            function: FUNCTION_URL,
                            parameters: [
                              { key: 'actionName', value: 'dismissTask' },
                              { key: 'pendingId', value: mostRecent!.id },
                              { key: 'taskIndex', value: i.toString() }
                            ]
                          }
                        }
                      }
                    ]
                  }
                }
              ]
            }
          ]
        }
      });
    });

    const cardResponse = {
      text: `Found ${activeTasks.length} pending tasks from ${mostRecent.meetingInfo.title}`,
      cardsV2: cards
    };

    console.log('Sending card response...');
    const wrappedResponse = wrapResponse(cardResponse);
    console.log('Response:', JSON.stringify(wrappedResponse).substring(0, 1000) + '...');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(wrappedResponse);
    console.log('Response sent successfully');
    return true;
  } catch (error: any) {
    console.error('Error showing pending tasks:', error);
    // If index error, show friendly message
    if (error?.code === 9 || error?.message?.includes('index')) {
      res.setHeader('Content-Type', 'application/json');
      res.status(200).json(wrapResponse({
        text: `⏳ The database index is still being created. Please try again in a few minutes.\n\nIn the meantime, type \`help\` to see available commands.`
      }));
      return true;
    }
    // Show error to user
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(wrapResponse({
      text: `❌ Error loading tasks: ${error?.message || 'Unknown error'}. Please try again.`
    }));
    return true;
  }
}

/**
 * Handle card button clicks.
 */
async function handleCardClick(
  event: ChatCardInteraction,
  res: Response
): Promise<void> {
  const action = event.action;
  if (!action) {
    console.warn('Card click event without action');
    res.json(wrapResponse({ text: 'No action found.' }));
    return;
  }

  // Get parameters - for Workspace Add-ons, action name is in parameters
  const params = Object.fromEntries(
    (action.parameters || []).map((p: any) => [p.key, p.value])
  );

  // Action name can be in actionMethodName (old format) or parameters.actionName (Workspace Add-ons)
  const actionName = action.actionMethodName || params.actionName;

  // Get form inputs if available
  const formInputs = event.common?.formInputs || {};

  console.log(`Card action: ${actionName}`, params);

  const spaceName = event.space?.name || '';

  switch (actionName) {
    case 'createTask':
      await handleCreateTask(params, formInputs, spaceName, res);
      break;

    case 'dismissTask':
      await handleDismissTask(params, res);
      break;

    case 'createAllTasks':
      await handleCreateAllTasks(params, formInputs, spaceName, res);
      break;

    case 'dismissAllTasks':
      await handleDismissAllTasks(params, res);
      break;

    default:
      console.warn(`Unknown action: ${actionName}`);
      res.json({});
  }
}

/**
 * Handle create single task action.
 */
async function handleCreateTask(
  params: Record<string, string>,
  formInputs: Record<string, { stringInputs?: { value: string[] } }>,
  spaceName: string,
  res: Response
): Promise<void> {
  const { pendingId, taskIndex } = params;
  const index = parseInt(taskIndex, 10);

  try {
    // Get pending tasks
    const pending = await getPendingTasks(pendingId);
    if (!pending) {
      res.json(wrapResponse({ text: '❌ Task data not found. It may have expired.' }));
      return;
    }

    const task = pending.tasks[index];
    if (!task) {
      res.json(wrapResponse({ text: '❌ Task not found.' }));
      return;
    }

    // Apply any edits from the form
    const updatedTask = applyFormEdits(task, index, formInputs);

    // Update stored task with edits
    await updateTaskDetails(pendingId, index, updatedTask);

    // Create the task in ClickUp
    // Parse assignee ID - form dropdowns return numeric IDs, but OpenAI returns names
    let assigneeId: number | undefined;
    if (updatedTask.suggested_assignee) {
      const parsed = parseInt(updatedTask.suggested_assignee, 10);
      if (!isNaN(parsed)) {
        assigneeId = parsed;
      }
      // If it's a name (NaN), skip - the user can assign later in ClickUp
    }

    // Build rich description with meeting context
    const descriptionParts = [updatedTask.description || updatedTask.title];
    descriptionParts.push('');
    descriptionParts.push(`---`);
    descriptionParts.push(`📋 Meeting: ${pending.meetingInfo.title}`);
    descriptionParts.push(`📅 Date: ${pending.meetingInfo.date}`);
    descriptionParts.push(`📁 Folder: ${pending.folderConfig.name}`);
    if (updatedTask.source_quote && !updatedTask.source_quote.includes('[Confidential')) {
      descriptionParts.push(`💬 Source: "${updatedTask.source_quote}"`);
    }
    descriptionParts.push(`🤖 Extraction: ${updatedTask.extraction_type} (${Math.round(updatedTask.confidence * 100)}% confidence)`);

    const clickupTask = await createTask(task.clickupListId, {
      name: updatedTask.title,
      description: descriptionParts.join('\n'),
      assigneeId,
      dueDate: updatedTask.suggested_due || undefined,
      priority: updatedTask.priority,
      extractionType: updatedTask.extraction_type,
      sourceFolder: pending.folderConfig.name
    });

    // Mark task as created
    await markTaskAsCreated(pendingId, index, clickupTask.id);

    // Get list name for confirmation
    const listDetails = await getListDetails(task.clickupListId);

    // Send confirmation card with clickable link to ClickUp task
    res.json(wrapResponse({
      text: `✅ Task created: ${clickupTask.name}`,
      cardsV2: [
        {
          cardId: `created_${index}`,
          card: {
            header: {
              title: '✅ Task Created Successfully',
              subtitle: listDetails.name
            },
            sections: [
              {
                widgets: [
                  {
                    decoratedText: {
                      topLabel: 'Task',
                      text: clickupTask.name,
                      wrapText: true
                    }
                  },
                  {
                    decoratedText: {
                      topLabel: 'List',
                      text: listDetails.name
                    }
                  },
                  {
                    buttonList: {
                      buttons: [
                        {
                          text: '🔗 View in ClickUp',
                          onClick: {
                            openLink: {
                              url: clickupTask.url
                            }
                          }
                        }
                      ]
                    }
                  }
                ]
              }
            ]
          }
        }
      ]
    }));

  } catch (error) {
    console.error('Error creating task:', error);
    res.json(wrapResponse({
      text: `❌ Failed to create task: ${error instanceof Error ? error.message : 'Unknown error'}`
    }));
  }
}

/**
 * Handle dismiss single task action.
 */
async function handleDismissTask(
  params: Record<string, string>,
  res: Response
): Promise<void> {
  const { pendingId, taskIndex } = params;
  const index = parseInt(taskIndex, 10);

  try {
    await markTaskAsDismissed(pendingId, index);
    res.json(wrapResponse({ text: '👍 Task dismissed.' }));
  } catch (error) {
    console.error('Error dismissing task:', error);
    res.json(wrapResponse({ text: '❌ Failed to dismiss task.' }));
  }
}

/**
 * Handle create all tasks action.
 */
async function handleCreateAllTasks(
  params: Record<string, string>,
  formInputs: Record<string, { stringInputs?: { value: string[] } }>,
  spaceName: string,
  res: Response
): Promise<void> {
  const { pendingId } = params;

  try {
    const pending = await getPendingTasks(pendingId);
    if (!pending) {
      res.json(wrapResponse({ text: '❌ Task data not found. It may have expired.' }));
      return;
    }

    await updatePendingTasksStatus(pendingId, 'processing');

    const results: Array<{ success: boolean; name: string; url: string; error?: string }> = [];
    let successCount = 0;
    let eligibleCount = 0;

    for (let i = 0; i < pending.tasks.length; i++) {
      const task = pending.tasks[i];

      // Skip already created or dismissed tasks
      if ((task as any).clickupTaskId || (task as any).dismissed) {
        continue;
      }

      eligibleCount++;

      try {
        // Apply any form edits
        const updatedTask = applyFormEdits(task, i, formInputs);

        let bulkAssigneeId: number | undefined;
        if (updatedTask.suggested_assignee) {
          const parsed = parseInt(updatedTask.suggested_assignee, 10);
          if (!isNaN(parsed)) {
            bulkAssigneeId = parsed;
          }
        }

        // Build rich description with meeting context (same as single task creation)
        const bulkDescParts = [updatedTask.description || updatedTask.title];
        bulkDescParts.push('');
        bulkDescParts.push(`---`);
        bulkDescParts.push(`📋 Meeting: ${pending.meetingInfo.title}`);
        bulkDescParts.push(`📅 Date: ${pending.meetingInfo.date}`);
        bulkDescParts.push(`📁 Folder: ${pending.folderConfig.name}`);
        if (updatedTask.source_quote && !updatedTask.source_quote.includes('[Confidential')) {
          bulkDescParts.push(`💬 Source: "${updatedTask.source_quote}"`);
        }
        bulkDescParts.push(`🤖 Extraction: ${updatedTask.extraction_type} (${Math.round(updatedTask.confidence * 100)}% confidence)`);

        const clickupTask = await createTask(task.clickupListId, {
          name: updatedTask.title,
          description: bulkDescParts.join('\n'),
          assigneeId: bulkAssigneeId,
          dueDate: updatedTask.suggested_due || undefined,
          priority: updatedTask.priority,
          extractionType: updatedTask.extraction_type,
          sourceFolder: pending.folderConfig.name
        });

        await markTaskAsCreated(pendingId, i, clickupTask.id);
        results.push({ success: true, name: clickupTask.name, url: clickupTask.url });
        successCount++;

        // Small delay between creations
        await sleep(200);
      } catch (error) {
        results.push({ success: false, name: task.title, url: '', error: error instanceof Error ? error.message : 'Failed' });
      }
    }

    await updatePendingTasksStatus(pendingId, 'completed');

    // Build result cards with clickable links for each created task
    const resultWidgets: any[] = results.map((r: any) => {
      if (r.success) {
        return {
          decoratedText: {
            topLabel: '✅ Created',
            text: r.name,
            wrapText: true,
            button: {
              text: 'View',
              onClick: {
                openLink: { url: r.url }
              }
            }
          }
        };
      }
      return {
        decoratedText: {
          topLabel: '❌ Failed',
          text: `${r.name}: ${r.error}`,
          wrapText: true
        }
      };
    });

    res.json(wrapResponse({
      text: `📋 Bulk creation: ${successCount}/${eligibleCount} tasks created`,
      cardsV2: [
        {
          cardId: 'bulk_results',
          card: {
            header: {
              title: `📋 Bulk Task Creation Complete`,
              subtitle: `${successCount}/${eligibleCount} tasks created successfully`
            },
            sections: [{ widgets: resultWidgets }]
          }
        }
      ]
    }));

  } catch (error) {
    console.error('Error creating all tasks:', error);
    res.json(wrapResponse({
      text: `❌ Failed to create tasks: ${error instanceof Error ? error.message : 'Unknown error'}`
    }));
  }
}

/**
 * Handle dismiss all tasks action.
 */
async function handleDismissAllTasks(
  params: Record<string, string>,
  res: Response
): Promise<void> {
  const { pendingId } = params;

  try {
    const pending = await getPendingTasks(pendingId);
    if (!pending) {
      res.json(wrapResponse({ text: '❌ Task data not found.' }));
      return;
    }

    for (let i = 0; i < pending.tasks.length; i++) {
      const task = pending.tasks[i] as any;
      if (!task.clickupTaskId && !task.dismissed) {
        await markTaskAsDismissed(pendingId, i);
      }
    }

    await updatePendingTasksStatus(pendingId, 'completed');

    res.json(wrapResponse({ text: '👍 All tasks dismissed.' }));
  } catch (error) {
    console.error('Error dismissing all tasks:', error);
    res.json(wrapResponse({ text: '❌ Failed to dismiss tasks.' }));
  }
}

/**
 * Apply form edits to a task.
 */
function applyFormEdits(
  task: any,
  index: number,
  formInputs: Record<string, { stringInputs?: { value: string[] } }>
): any {
  const updated = { ...task };

  // Title
  const titleInput = formInputs[`title_${index}`];
  if (titleInput?.stringInputs?.value?.[0]) {
    updated.title = titleInput.stringInputs.value[0];
  }

  // Assignee
  const assigneeInput = formInputs[`assignee_${index}`];
  if (assigneeInput?.stringInputs?.value?.[0]) {
    updated.suggested_assignee = assigneeInput.stringInputs.value[0];
  }

  // Due date
  const dueDateInput = formInputs[`dueDate_${index}`];
  if (dueDateInput?.stringInputs?.value?.[0]) {
    // Convert milliseconds epoch to ISO date
    const timestamp = parseInt(dueDateInput.stringInputs.value[0], 10);
    if (!isNaN(timestamp)) {
      updated.suggested_due = new Date(timestamp).toISOString().split('T')[0];
    }
  }

  // Priority
  const priorityInput = formInputs[`priority_${index}`];
  if (priorityInput?.stringInputs?.value?.[0]) {
    updated.priority = priorityInput.stringInputs.value[0] as TaskPriority;
  }

  return updated;
}

/**
 * Simple sleep utility.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
