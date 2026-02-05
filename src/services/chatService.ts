import { google } from 'googleapis';
import type {
  ExtractedTaskWithConfig,
  MeetingInfo,
  ClickUpMember,
  TaskPriority
} from '../types/index.js';
import { getWorkspaceMembers } from './clickupService.js';

// Use any for Chat API types since they vary between versions
type ChatClient = ReturnType<typeof google.chat>;
type ChatMessage = any;
type ChatCard = any;
type ChatWidget = any;

// Priority display configuration
const PRIORITY_DISPLAY: Record<TaskPriority, { emoji: string; label: string }> = {
  urgent: { emoji: '🔴', label: 'Urgent' },
  high: { emoji: '🟠', label: 'High' },
  normal: { emoji: '🟡', label: 'Normal' },
  low: { emoji: '🔵', label: 'Low' }
};

// Function URL for Workspace Add-on actions
const CHAT_FUNCTION_URL = process.env.CHAT_FUNCTION_URL || 'https://handlechatinteraction-jrgrpko2qa-uc.a.run.app';

// Initialize Chat client
function getChatClient(): ChatClient {
  const auth = new google.auth.GoogleAuth({
    scopes: [
      'https://www.googleapis.com/auth/chat.bot',
      'https://www.googleapis.com/auth/chat.spaces',
      'https://www.googleapis.com/auth/chat.spaces.create',
      'https://www.googleapis.com/auth/chat.messages',
      'https://www.googleapis.com/auth/chat.messages.create'
    ]
  });
  return google.chat({ version: 'v1', auth });
}

/**
 * Send task approval cards to a Google Chat space.
 */
export async function sendTaskApprovalCards(params: {
  spaceId: string;
  pendingId: string;
  tasks: ExtractedTaskWithConfig[];
  meetingInfo: MeetingInfo;
  folderName: string;
}): Promise<void> {
  const chat = getChatClient();
  const { spaceId, pendingId, tasks, meetingInfo, folderName } = params;

  // Get ClickUp members for assignee dropdown
  const members = await getWorkspaceMembers();

  // Build the card message
  const cardMessage = buildTaskApprovalMessage(
    pendingId,
    tasks,
    meetingInfo,
    folderName,
    members
  );

  await chat.spaces.messages.create({
    parent: spaceId,
    requestBody: cardMessage
  });

  console.log(`Sent approval cards to space: ${spaceId}`);
}

/**
 * Send task approval cards via DM to a user.
 * Note: Requires domain-wide delegation OR the user to have messaged the bot first.
 */
export async function sendDMToUser(params: {
  userEmail: string;
  pendingId: string;
  tasks: ExtractedTaskWithConfig[];
  meetingInfo: MeetingInfo;
  folderName: string;
}): Promise<void> {
  const chat = getChatClient();
  const { userEmail, pendingId, tasks, meetingInfo, folderName } = params;

  // Get ClickUp members for assignee dropdown
  const members = await getWorkspaceMembers();

  // Try to find an existing DM space with this user, or create one
  let spaceName: string | null = null;

  try {
    // First try to list existing spaces to find a DM with this user
    const spacesResponse = await chat.spaces.list({
      filter: 'spaceType = "DIRECT_MESSAGE"'
    });

    const existingDM = ((spacesResponse.data as any).spaces || []).find((space: any) => {
      // Check if this DM space is with the target user
      return space.singleUserBotDm === false; // It's a human DM
    });

    if (existingDM && existingDM.name) {
      // Check membership to confirm it's with the right user
      const membersResponse = await chat.spaces.members.list({
        parent: existingDM.name as string
      });

      const hasUser = ((membersResponse.data as any).memberships || []).some((m: any) =>
        m.member?.name?.includes(userEmail) || m.member?.email === userEmail
      );

      if (hasUser) {
        spaceName = existingDM.name as string;
        console.log(`Found existing DM space with ${userEmail}: ${spaceName}`);
      }
    }
  } catch (listError) {
    console.log('Could not list existing spaces, will try to create DM:', listError);
  }

  // If no existing space found, try to create one
  if (!spaceName) {
    try {
      const dmResponse = await chat.spaces.setup({
        requestBody: {
          space: {
            spaceType: 'DIRECT_MESSAGE'
          },
          memberships: [
            {
              member: {
                name: `users/${userEmail}`,
                type: 'HUMAN'
              }
            }
          ]
        }
      });

      spaceName = (dmResponse.data as any).space?.name;
    } catch (setupError: any) {
      // If we can't create a DM, log and provide instructions
      console.error(`Cannot send DM to ${userEmail}. Error: ${setupError.message}`);
      console.log('To enable DMs, the user needs to message the bot first, or enable domain-wide delegation.');
      console.log(`Pending tasks ID: ${pendingId} - User can access via the Chat bot.`);
      throw setupError;
    }
  }

  if (!spaceName) {
    throw new Error(`Failed to create or find DM with user: ${userEmail}`);
  }

  // Build and send the card message
  const cardMessage = buildTaskApprovalMessage(
    pendingId,
    tasks,
    meetingInfo,
    folderName,
    members
  );

  await chat.spaces.messages.create({
    parent: spaceName,
    requestBody: cardMessage
  });

  console.log(`Sent approval cards via DM to: ${userEmail}`);
}

/**
 * Build the task approval card message.
 */
export function buildTaskApprovalMessage(
  pendingId: string,
  tasks: ExtractedTaskWithConfig[],
  meetingInfo: MeetingInfo,
  folderName: string,
  members: ClickUpMember[]
): ChatMessage {
  const cards: ChatCard[] = [];

  // Header card with meeting info
  const headerCard: ChatCard = {
    cardId: 'header',
    card: {
      header: {
        title: `📋 Tasks from: ${meetingInfo.title}`,
        subtitle: `📁 ${folderName} • 📅 ${formatDate(meetingInfo.date)}`,
        imageType: 'CIRCLE'
      },
      sections: [
        {
          widgets: [
            {
              decoratedText: {
                topLabel: 'Tasks Found',
                text: `${tasks.length} task${tasks.length !== 1 ? 's' : ''} extracted from this meeting`
              }
            }
          ]
        }
      ]
    }
  };
  cards.push(headerCard);

  // Individual task cards
  tasks.forEach((task, index) => {
    const taskCard = buildTaskCard(task, index, pendingId, members);
    cards.push(taskCard);
  });

  // Footer card with bulk actions
  if (tasks.length > 1) {
    const footerCard: ChatCard = {
      cardId: 'footer',
      card: {
        sections: [
          {
            widgets: [
              {
                buttonList: {
                  buttons: [
                    {
                      text: '✅ Create All Tasks',
                      onClick: {
                        action: {
                          function: CHAT_FUNCTION_URL,
                          parameters: [
                            { key: 'actionName', value: 'createAllTasks' },
                            { key: 'pendingId', value: pendingId }
                          ]
                        }
                      }
                    },
                    {
                      text: '❌ Dismiss All',
                      onClick: {
                        action: {
                          function: CHAT_FUNCTION_URL,
                          parameters: [
                            { key: 'actionName', value: 'dismissAllTasks' },
                            { key: 'pendingId', value: pendingId }
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
    };
    cards.push(footerCard);
  }

  return {
    cardsV2: cards
  };
}

/**
 * Build a card for a single task.
 */
function buildTaskCard(
  task: ExtractedTaskWithConfig,
  index: number,
  pendingId: string,
  members: ClickUpMember[]
): ChatCard {
  const priorityInfo = PRIORITY_DISPLAY[task.priority];
  const typeIndicator = task.extraction_type === 'explicit' ? '✅ EXPLICIT' : '🔍 DETECTED';

  const widgets: ChatWidget[] = [];

  // Task type indicator
  widgets.push({
    decoratedText: {
      topLabel: 'Type',
      text: `${typeIndicator} (Confidence: ${Math.round(task.confidence * 100)}%)`
    }
  });

  // Editable title
  widgets.push({
    textInput: {
      label: 'Task Title',
      name: `title_${index}`,
      value: task.title,
      type: 'SINGLE_LINE'
    }
  });

  // Assignee dropdown
  const assigneeItems = [
    { text: '-- Select Assignee --', value: '' },
    ...members.map(m => ({
      text: `${m.username} (${m.email})`,
      value: m.id.toString()
    }))
  ];

  widgets.push({
    selectionInput: {
      label: 'Assignee',
      name: `assignee_${index}`,
      type: 'DROPDOWN',
      items: assigneeItems,
      ...(task.suggested_assignee && {
        selectedValues: [findMemberIdByName(task.suggested_assignee, members)]
      })
    }
  });

  // Due date picker
  widgets.push({
    dateTimePicker: {
      label: 'Due Date',
      name: `dueDate_${index}`,
      type: 'DATE_ONLY',
      ...(task.suggested_due && {
        valueMsEpoch: new Date(task.suggested_due).getTime().toString()
      })
    }
  });

  // Priority dropdown
  widgets.push({
    selectionInput: {
      label: 'Priority',
      name: `priority_${index}`,
      type: 'DROPDOWN',
      items: [
        { text: `${PRIORITY_DISPLAY.urgent.emoji} Urgent`, value: 'urgent' },
        { text: `${PRIORITY_DISPLAY.high.emoji} High`, value: 'high' },
        { text: `${PRIORITY_DISPLAY.normal.emoji} Normal`, value: 'normal' },
        { text: `${PRIORITY_DISPLAY.low.emoji} Low`, value: 'low' }
      ],
      selectedValues: [task.priority]
    }
  });

  // Source quote (collapsible) - unless confidential
  if (task.source_quote && !task.source_quote.includes('[Confidential')) {
    widgets.push({
      decoratedText: {
        topLabel: 'Source Quote',
        text: task.source_quote.length > 200
          ? task.source_quote.substring(0, 200) + '...'
          : task.source_quote,
        wrapText: true
      }
    });
  }

  // Action buttons
  widgets.push({
    buttonList: {
      buttons: [
        {
          text: '✅ Create Task',
          onClick: {
            action: {
              function: CHAT_FUNCTION_URL,
              parameters: [
                { key: 'actionName', value: 'createTask' },
                { key: 'pendingId', value: pendingId },
                { key: 'taskIndex', value: index.toString() }
              ]
            }
          }
        },
        {
          text: '❌ Dismiss',
          onClick: {
            action: {
              function: CHAT_FUNCTION_URL,
              parameters: [
                { key: 'actionName', value: 'dismissTask' },
                { key: 'pendingId', value: pendingId },
                { key: 'taskIndex', value: index.toString() }
              ]
            }
          }
        }
      ]
    }
  });

  return {
    cardId: `task_${index}`,
    card: {
      header: {
        title: `${priorityInfo.emoji} Task ${index + 1}`,
        subtitle: task.title.substring(0, 50) + (task.title.length > 50 ? '...' : '')
      },
      sections: [
        {
          widgets
        }
      ]
    }
  };
}

/**
 * Send a confirmation message after task creation.
 */
export async function sendTaskCreatedConfirmation(
  spaceId: string,
  taskName: string,
  taskUrl: string,
  listName: string
): Promise<void> {
  const chat = getChatClient();

  await chat.spaces.messages.create({
    parent: spaceId,
    requestBody: {
      text: `✅ Task created successfully!\n\n*${taskName}*\n📋 List: ${listName}\n🔗 ${taskUrl}`
    }
  });
}

/**
 * Send an error message.
 */
export async function sendErrorMessage(
  spaceId: string,
  errorMessage: string
): Promise<void> {
  const chat = getChatClient();

  await chat.spaces.messages.create({
    parent: spaceId,
    requestBody: {
      text: `❌ Error: ${errorMessage}`
    }
  });
}

/**
 * Update a card message to show task was created.
 */
export async function updateCardWithSuccess(
  messageName: string,
  taskIndex: number,
  taskUrl: string
): Promise<void> {
  const chat = getChatClient();

  // Update the specific card to show success state
  await chat.spaces.messages.update({
    name: messageName,
    updateMask: 'cardsV2',
    requestBody: {
      cardsV2: [
        {
          cardId: `task_${taskIndex}_success`,
          card: {
            sections: [
              {
                widgets: [
                  {
                    decoratedText: {
                      text: '✅ Task created successfully!',
                      button: {
                        text: 'View in ClickUp',
                        onClick: {
                          openLink: {
                            url: taskUrl
                          }
                        }
                      }
                    }
                  }
                ]
              }
            ]
          }
        }
      ]
    }
  });
}

/**
 * Helper to find member ID by name.
 */
function findMemberIdByName(name: string | null | undefined, members: ClickUpMember[]): string {
  if (!name) return '';
  const normalizedName = name.toLowerCase();
  const member = members.find(m => {
    const username = m.username || '';
    const email = m.email || '';
    return username.toLowerCase().includes(normalizedName) ||
           email.toLowerCase().includes(normalizedName);
  });
  return member?.id.toString() || '';
}

/**
 * Format date for display.
 */
function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch {
    return dateStr;
  }
}
