# Meeting Transcript Bot - Developer Overview

## What It Does

Monitors Google Drive folders for meeting transcripts, extracts tasks using OpenAI GPT-4o, sends interactive approval cards via Google Chat, and creates approved tasks in ClickUp.

---

## Architecture

```
Google Drive (file upload)
    │
    ▼
Drive Push Notification (webhook)
    │
    ▼
driveWebhook() ──► Pub/Sub topic: meeting-transcripts
                        │
                        ▼
                processTranscript()
                    │
                    ├── Download file from Drive
                    ├── Parse transcript (VTT, SRT, Zoom, Teams, Google Meet, plain text)
                    ├── Extract tasks via OpenAI GPT-4o (structured output with Zod)
                    ├── Store pending tasks in Firestore
                    └── Send approval cards to Google Chat
                            │
                            ▼
                    handleChatInteraction()
                        │
                        ├── User clicks "Create Task" → ClickUp API
                        ├── User clicks "Dismiss" → Mark dismissed in Firestore
                        └── User clicks "Create All" → Bulk create in ClickUp
```

---

## Cloud Functions

| Function | Trigger | Purpose |
|---|---|---|
| `processTranscript` | Pub/Sub (`meeting-transcripts`) | Downloads transcript, extracts tasks via OpenAI, stores in Firestore, sends Chat cards |
| `handleChatInteraction` | HTTP POST (Google Chat webhook) | Handles messages, button clicks, creates/dismisses tasks |
| `setupDriveWatchers` | HTTP POST | Sets up Drive push notification channels for monitored folders |
| `driveWebhook` | HTTP POST (Drive push notification) | Receives file change events, publishes to Pub/Sub |

---

## Project Structure

```
src/
├── config/
│   └── index.ts                  # Config loader (default.json, folders.json)
├── functions/
│   ├── processTranscript.ts      # Main transcript processing pipeline
│   ├── handleChatInteraction.ts  # Google Chat webhook handler
│   └── setupDriveWatchers.ts     # Drive watcher setup + driveWebhook
├── services/
│   ├── driveService.ts           # Drive API: watchers, file download, metadata
│   ├── firestoreService.ts       # Firestore CRUD for pending tasks & watchers
│   ├── clickupService.ts         # ClickUp API: task creation, member lookup
│   ├── openaiService.ts          # OpenAI GPT-4o task extraction
│   └── chatService.ts            # Google Chat: card building, DM sending
├── utils/
│   ├── transcriptParser.ts       # Multi-format transcript parser
│   ├── folderConfigResolver.ts   # Folder-specific config resolution
│   ├── dateResolver.ts           # "next Friday" → ISO date
│   └── memberMapper.ts           # Name → ClickUp member ID
├── schemas/
│   └── taskSchema.ts             # Zod schemas for OpenAI structured output
├── types/
│   └── index.ts                  # TypeScript interfaces
└── index.ts                      # Cloud Function exports

config/
├── default.json                  # GCP, OpenAI, ClickUp settings
└── folders.json                  # Monitored Drive folders config
```

---

## Configuration

### `config/default.json`

```json
{
  "gcp": {
    "projectId": "meeting-bot-486305",
    "pubsubTopic": "meeting-transcripts",
    "firestoreCollection": "pending-tasks"
  },
  "openai": {
    "model": "gpt-4o",
    "fallbackModel": "gpt-4o-mini",
    "confidenceThreshold": 0.7
  },
  "clickup": {
    "workspaceId": "8459040"
  },
  "driveWatcher": {
    "renewalIntervalHours": 12
  }
}
```

### `config/folders.json` - Drive Folder Configuration

This is where monitored Drive folders are configured. Each entry maps a Google Drive folder to notification and task settings.

```json
{
  "clickupListId": "901802953947",
  "globalNotifyUsers": ["khalid@k-brands.com"],
  "folders": [
    {
      "id": "GOOGLE_DRIVE_FOLDER_ID",
      "name": "Human-readable folder name",
      "taskPrefix": "[Meeting]",
      "notifyChat": {
        "type": "dm_owner"
      },
      "confidential": false,
      "alwaysNotifyUsers": []
    }
  ],
  "defaultConfig": {
    "taskPrefix": "",
    "notifyChat": { "type": "dm_owner" }
  }
}
```

**Folder fields:**

| Field | Required | Description |
|---|---|---|
| `id` | Yes | Google Drive folder ID (from URL: `drive.google.com/drive/folders/{ID}`) |
| `name` | Yes | Display name used in Chat cards |
| `taskPrefix` | No | Prefix added to all task titles, e.g. `[Meeting]` |
| `notifyChat.type` | Yes | `"dm_owner"` (DM the file owner) or `"space"` (post to a Chat space) |
| `notifyChat.spaceId` | If type=space | Google Chat space ID, e.g. `"spaces/AAAA1234"` |
| `confidential` | No | If `true`, source quotes are redacted from cards |
| `alwaysNotifyUsers` | No | Additional emails to notify for this folder |

**Adding a new folder:**

1. Add entry to `config/folders.json` with the Drive folder ID
2. Redeploy the functions: `npm run build && gcloud functions deploy ...`
3. Run watcher setup: `curl -X POST "https://.../setupDriveWatchers?mode=full"`

---

## Environment Variables & Secrets

| Variable | Source | Used By |
|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | Env var | All functions |
| `OPENAI_API_KEY` | Secret Manager | processTranscript |
| `CLICKUP_API_KEY` | Secret Manager | handleChatInteraction, processTranscript |
| `CHAT_FUNCTION_URL` | Hardcoded | chatService.ts (button action URLs) |

---

## Firestore Data Model

### Collection: `pending-tasks`

```
Document ID: UUID

{
  fileId: string,                    // Drive file ID
  folderId: string,                  // Drive folder ID
  folderConfig: { ... },             // Snapshot of folder config at processing time
  tasks: [
    {
      title: string,
      description: string,
      suggested_assignee: string | null,
      suggested_due: string | null,    // ISO date
      priority: "urgent" | "high" | "normal" | "low",
      source_quote: string,
      confidence: number,              // 0.0 - 1.0
      extraction_type: "explicit" | "implicit",
      clickupListId: string,
      clickupTaskId?: string,          // Set after creation
      dismissed?: boolean              // Set if user dismisses
    }
  ],
  meetingInfo: {
    title: string,
    date: string,
    attendees: string[],
    folderId: string,
    folderName: string
  },
  analysis: {
    meeting_summary: string,
    decisions: string[]
  },
  status: "pending" | "processing" | "completed",
  createdAt: Timestamp
}
```

### Collection: `drive-watchers`

```
Document ID: folderId

{
  channelId: string,        // "meeting-bot-{folderId}-{timestamp}"
  folderId: string,
  resourceId: string,
  expiration: Timestamp,     // 23 hours from creation
  createdAt: Timestamp
}
```

**Required Firestore indexes:**
- `pending-tasks`: `status` ASC + `createdAt` DESC
- `pending-tasks`: `fileId` ASC + `status` ASC

---

## Google Workspace Add-ons Response Format

The Chat bot is configured as a Google Workspace Add-on. All responses must be wrapped:

```json
{
  "hostAppDataAction": {
    "chatDataAction": {
      "createMessageAction": {
        "message": {
          "text": "Your message",
          "cardsV2": [{ ... }]
        }
      }
    }
  }
}
```

Button click events arrive with parameters in `commonEventObject.parameters` and the payload in `chat.buttonClickedPayload`.

---

## Key Technical Details

### Task Extraction

- **Explicit tasks**: Direct statements like "Action item: X", "Task for Y: Z" (confidence ~1.0)
- **Implicit tasks**: Inferred from context like "I'll follow up on..." (confidence 0.5-0.9)
- Tasks below the confidence threshold (0.7) are filtered out
- Large transcripts are chunked and results merged/deduplicated

### Transcript Formats Supported

- Google Meet notes
- WebVTT (.vtt)
- SRT subtitles (.srt)
- Zoom chat transcripts
- Microsoft Teams transcripts
- Plain text / Google Docs

### ClickUp Priority Mapping

| Bot Priority | ClickUp Value |
|---|---|
| urgent | 1 |
| high | 2 |
| normal | 3 |
| low | 4 |

### Drive Watcher Lifecycle

1. `setupDriveWatchers?mode=full` creates watchers for all configured folders
2. Watchers expire after 23 hours
3. Cloud Scheduler runs daily to renew expiring watchers
4. Old watchers are stopped before creating new ones

---

## Deployment Commands

```bash
# Build
npm run build

# Deploy all functions
gcloud functions deploy processTranscript \
  --gen2 --runtime=nodejs20 --region=us-central1 \
  --source=. --entry-point=processTranscript \
  --trigger-topic=meeting-transcripts \
  --memory=512MB --timeout=300s \
  --set-secrets="OPENAI_API_KEY=openai-api-key:latest,CLICKUP_API_KEY=clickup-api-key:latest"

gcloud functions deploy handleChatInteraction \
  --gen2 --runtime=nodejs20 --region=us-central1 \
  --source=. --entry-point=handleChatInteraction \
  --trigger-http --allow-unauthenticated \
  --memory=256MB --timeout=60s \
  --set-secrets="CLICKUP_API_KEY=clickup-api-key:latest"

gcloud functions deploy setupDriveWatchers \
  --gen2 --runtime=nodejs20 --region=us-central1 \
  --source=. --entry-point=setupDriveWatchers \
  --trigger-http --allow-unauthenticated \
  --memory=256MB --timeout=120s

gcloud functions deploy driveWebhook \
  --gen2 --runtime=nodejs20 --region=us-central1 \
  --source=. --entry-point=driveWebhook \
  --trigger-http --allow-unauthenticated \
  --memory=256MB --timeout=30s

# Setup drive watchers after deploy
curl -X POST "https://REGION-PROJECT.cloudfunctions.net/setupDriveWatchers?mode=full"
```

---

## Service Account

- Email: `meeting-task-bot@meeting-bot-486305.iam.gserviceaccount.com`
- Required roles:
  - `roles/cloudfunctions.invoker`
  - `roles/pubsub.publisher`
  - `roles/datastore.user`
  - Drive API: Read-only access to monitored folders
  - Chat API: Bot messaging permissions

---

## GCP Resources

| Resource | Name / ID |
|---|---|
| Project | `meeting-bot-486305` |
| Pub/Sub Topic | `meeting-transcripts` |
| Firestore Database | Default |
| Cloud Scheduler | Daily watcher renewal (00:00 UTC) |
| Secret Manager | `openai-api-key`, `clickup-api-key` |
| ClickUp Workspace | `8459040` |
| ClickUp List | `901802953947` |
