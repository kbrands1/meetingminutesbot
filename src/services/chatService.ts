import { google } from 'googleapis';
import type {
  ExtractedTaskWithConfig,
  MeetingInfo,
  MeetingAnalysis,
  ClickUpMember,
  TaskPriority
} from '../types/index.js';
import { getWorkspaceMembers } from './clickupService.js';
import { getChatFunctionUrl } from '../config/index.js';

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

// Function URL for Workspace Add-on actions (lazy-loaded to avoid startup errors)
let _chatFunctionUrl: string | null = null;
function getChatFunctionUrlCached(): string {
  if (!_chatFunctionUrl) {
    _chatFunctionUrl = getChatFunctionUrl();
  }
  return _chatFunctionUrl;
}

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
  analysis?: MeetingAnalysis;
  transcriptLink?: string;
}): Promise<void> {
  const chat = getChatClient();
  const { spaceId, pendingId, tasks, meetingInfo, folderName, analysis, transcriptLink } = params;

  // Get ClickUp members for assignee dropdown
  const members = await getWorkspaceMembers();

  // Build the card message
  const cardMessage = buildTaskApprovalMessage(
    pendingId,
    tasks,
    meetingInfo,
    folderName,
    members,
    analysis,
    transcriptLink
  );

  await chat.spaces.messages.create({
    parent: spaceId,
    requestBody: cardMessage
  });

  console.log(`Sent approval cards to space: ${spaceId}`);
}

/**
 * Find an existing DM space with a user.
 * Returns the space name if found, null otherwise.
 * The bot can only find DM spaces where the user has previously messaged it.
 */
export async function findExistingDMSpace(userEmail: string): Promise<string | null> {
  const chat = getChatClient();

  try {
    // List DM spaces the bot is part of
    const spacesResponse = await chat.spaces.list({
      filter: 'spaceType = "DIRECT_MESSAGE"'
    });

    const allSpaces = (spacesResponse.data as any).spaces || [];

    // Check each DM space's membership to find the one with the target user
    for (const dmSpace of allSpaces) {
      if (!dmSpace.name) continue;

      // Skip bot-only DM spaces
      if (dmSpace.singleUserBotDm === true) continue;

      try {
        const membersResponse = await chat.spaces.members.list({
          parent: dmSpace.name as string
        });

        const hasUser = ((membersResponse.data as any).memberships || []).some((m: any) =>
          m.member?.name?.includes(userEmail) || m.member?.email === userEmail
        );

        if (hasUser) {
          return dmSpace.name as string;
        }
      } catch (memberError) {
        // Skip spaces we can't check
        continue;
      }
    }
  } catch (listError) {
    console.log(`Could not list spaces to find DM with ${userEmail}`);
  }

  return null;
}

/**
 * Send task approval cards via DM to a user.
 * The user must have messaged the bot at least once for this to work
 * (Google Chat API limitation - bots cannot initiate DMs with service accounts).
 *
 * Returns true if DM was sent successfully, false if user hasn't messaged the bot yet.
 */
export async function sendDMToUser(params: {
  userEmail: string;
  pendingId: string;
  tasks: ExtractedTaskWithConfig[];
  meetingInfo: MeetingInfo;
  folderName: string;
  analysis?: MeetingAnalysis;
  transcriptLink?: string;
}): Promise<boolean> {
  const chat = getChatClient();
  const { userEmail, pendingId, tasks, meetingInfo, folderName, analysis, transcriptLink } = params;

  // Find existing DM space (user must have messaged the bot first)
  const spaceName = await findExistingDMSpace(userEmail);

  if (!spaceName) {
    // This is expected when the user hasn't messaged the bot yet — not an error
    console.log(`No DM space with ${userEmail} — user needs to message the bot first. Pending ID: ${pendingId}`);
    return false;
  }

  console.log(`Found existing DM space with ${userEmail}: ${spaceName}`);

  // Get ClickUp members for assignee dropdown
  const members = await getWorkspaceMembers();

  // Build and send the card message
  const cardMessage = buildTaskApprovalMessage(
    pendingId,
    tasks,
    meetingInfo,
    folderName,
    members,
    analysis,
    transcriptLink
  );

  await chat.spaces.messages.create({
    parent: spaceName,
    requestBody: cardMessage
  });

  console.log(`Sent approval cards via DM to: ${userEmail}`);
  return true;
}

/**
 * Build the task approval card message.
 */
export function buildTaskApprovalMessage(
  pendingId: string,
  tasks: ExtractedTaskWithConfig[],
  meetingInfo: MeetingInfo,
  folderName: string,
  members: ClickUpMember[],
  analysis?: MeetingAnalysis,
  transcriptLink?: string
): ChatMessage {
  const cards: ChatCard[] = [];

  // Header card with meeting info, summary, and decisions
  const headerWidgets: ChatWidget[] = [];

  // Meeting summary
  if (analysis?.meeting_summary) {
    headerWidgets.push({
      decoratedText: {
        topLabel: 'Meeting Summary',
        text: analysis.meeting_summary,
        wrapText: true
      }
    });
  }

  // Key decisions
  if (analysis?.decisions && analysis.decisions.length > 0) {
    headerWidgets.push({
      decoratedText: {
        topLabel: 'Key Decisions',
        text: analysis.decisions.map(d => `• ${d}`).join('\n'),
        wrapText: true
      }
    });
  }

  // Task count + transcript link
  headerWidgets.push({
    decoratedText: {
      topLabel: 'Tasks Found',
      text: `${tasks.length} task${tasks.length !== 1 ? 's' : ''} extracted from this meeting`,
      ...(transcriptLink && {
        button: {
          text: '📄 View Transcript',
          onClick: {
            openLink: {
              url: transcriptLink
            }
          }
        }
      })
    }
  });

  // Attendees
  if (meetingInfo.attendees.length > 0) {
    headerWidgets.push({
      decoratedText: {
        topLabel: 'Attendees',
        text: meetingInfo.attendees.join(', ')
      }
    });
  }

  const headerCard: ChatCard = {
    cardId: 'header',
    card: {
      header: {
        title: `📋 ${meetingInfo.title}`,
        subtitle: `📁 ${folderName} • 📅 ${formatDate(meetingInfo.date)}`,
        imageType: 'CIRCLE'
      },
      sections: [
        {
          widgets: headerWidgets
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
                          function: getChatFunctionUrlCached(),
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
                          function: getChatFunctionUrlCached(),
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
              function: getChatFunctionUrlCached(),
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
              function: getChatFunctionUrlCached(),
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
