import type { Request, Response } from 'express';
import {
  getPendingTasks,
  updateTaskDetails,
  markTaskAsCreated,
  markTaskAsDismissed,
  updatePendingTasksStatus,
  getUserPendingTasks
} from '../services/firestoreService.js';
import { createTask, getListDetails, getWorkspaceMembers } from '../services/clickupService.js';
import {
  sendTaskCreatedConfirmation,
  sendErrorMessage,
  buildTaskApprovalMessage
} from '../services/chatService.js';
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

  if (messageText.includes('help')) {
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(wrapResponse({
      text: `📚 *Meeting Task Bot Help*\n\n• I automatically process meeting transcripts from monitored Drive folders\n• Tasks are extracted using AI and sent to you for approval\n• Use the card buttons to create tasks in ClickUp\n\n*Commands:*\n• \`help\` - Show this message\n• \`status\` - Check bot status\n• \`tasks\` or \`pending\` - Show your pending tasks`
    }));
    return;
  } else if (messageText.includes('status')) {
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(wrapResponse({
      text: `✅ Meeting Task Bot is running and monitoring folders for new transcripts.`
    }));
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

    // Get ClickUp members for assignee dropdown
    const members = await getWorkspaceMembers();
    console.log(`Loaded ${members.length} members`);

    // Get the most recent pending task set
    const mostRecent = pendingTasks[0];
    console.log(`Building card for ${mostRecent.tasks?.length || 0} tasks`);

    // Build cards with buttons for each task
    const FUNCTION_URL = 'https://handlechatinteraction-jrgrpko2qa-uc.a.run.app';

    const taskCards = mostRecent.tasks.slice(0, 5).map((t: any, i: number) => ({
      cardId: `task_${i}`,
      card: {
        name: `Task ${i + 1}`,
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
                            { key: 'pendingId', value: mostRecent.id },
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
                            { key: 'pendingId', value: mostRecent.id },
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
    }));

    const cardResponse = {
      text: `Found ${mostRecent.tasks.length} tasks from ${mostRecent.meetingInfo.title}`,
      cardsV2: taskCards
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
    const clickupTask = await createTask(task.clickupListId, {
      name: updatedTask.title,
      description: updatedTask.description,
      assigneeId: updatedTask.suggested_assignee
        ? parseInt(updatedTask.suggested_assignee, 10)
        : undefined,
      dueDate: updatedTask.suggested_due || undefined,
      priority: updatedTask.priority,
      extractionType: updatedTask.extraction_type,
      sourceFolder: pending.folderConfig.name
    });

    // Mark task as created
    await markTaskAsCreated(pendingId, index, clickupTask.id);

    // Get list name for confirmation
    const listDetails = await getListDetails(task.clickupListId);

    // Send confirmation
    res.json(wrapResponse({
      text: `✅ Task created!\n\n*${clickupTask.name}*\n📋 List: ${listDetails.name}\n🔗 ${clickupTask.url}`
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

    const results: string[] = [];
    let successCount = 0;

    for (let i = 0; i < pending.tasks.length; i++) {
      const task = pending.tasks[i];

      // Skip already created or dismissed tasks
      if ((task as any).clickupTaskId || (task as any).dismissed) {
        continue;
      }

      try {
        // Apply any form edits
        const updatedTask = applyFormEdits(task, i, formInputs);

        const clickupTask = await createTask(task.clickupListId, {
          name: updatedTask.title,
          description: updatedTask.description,
          assigneeId: updatedTask.suggested_assignee
            ? parseInt(updatedTask.suggested_assignee, 10)
            : undefined,
          dueDate: updatedTask.suggested_due || undefined,
          priority: updatedTask.priority
        });

        await markTaskAsCreated(pendingId, i, clickupTask.id);
        results.push(`✅ ${clickupTask.name}`);
        successCount++;

        // Small delay between creations
        await sleep(200);
      } catch (error) {
        results.push(`❌ ${task.title}: ${error instanceof Error ? error.message : 'Failed'}`);
      }
    }

    await updatePendingTasksStatus(pendingId, 'completed');

    res.json(wrapResponse({
      text: `📋 Bulk task creation complete!\n\n${successCount}/${pending.tasks.length} tasks created:\n${results.join('\n')}`
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
      if (!(pending.tasks[i] as any).clickupTaskId) {
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
