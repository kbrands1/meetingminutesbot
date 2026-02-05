# Meeting Transcript Bot - Testing Guide

## Prerequisites

- Google Cloud SDK (`gcloud`) installed and authenticated
- Node.js 20+
- Access to the GCP project `meeting-bot-486305`
- ClickUp API key with workspace access
- OpenAI API key
- Google Chat bot configured and accessible

---

## 1. Quick Smoke Test (End-to-End)

Upload a transcript file to the monitored Drive folder and verify the full flow.

### Step 1: Verify functions are deployed

```bash
gcloud functions list --region=us-central1
```

Expected output: `processTranscript`, `handleChatInteraction`, `setupDriveWatchers`, `driveWebhook` all with status `ACTIVE`.

### Step 2: Verify Drive watchers are active

```bash
# Check Firestore for active watchers
gcloud firestore documents list \
  --collection-ids=drive-watchers \
  --project=meeting-bot-486305
```

If empty, set up watchers:
```bash
curl -X POST "https://us-central1-meeting-bot-486305.cloudfunctions.net/setupDriveWatchers?mode=full"
```

### Step 3: Upload a test transcript

Upload the file `test/fixtures/sample-transcript.txt` (see below) to the monitored Google Drive folder.

### Step 4: Verify processing

```bash
# Check processTranscript logs (wait ~30s after upload)
gcloud functions logs read processTranscript --region=us-central1 --limit=20
```

Look for:
- `Processing transcript: {fileId}`
- `Extracted X tasks`
- `Stored pending tasks: {pendingId}`
- `Sent approval cards`

### Step 5: Check Google Chat

Open Google Chat, find the Meeting Task Bot DM. You should see interactive cards with extracted tasks.

### Step 6: Test button actions

- Click **"Create Task"** on one task → verify it appears in ClickUp list `901802953947`
- Click **"Dismiss"** on another task → verify confirmation message

---

## 2. Component Tests

### 2.1 Test Transcript Processing (Pub/Sub)

Manually publish a message to trigger processing without uploading a file:

```bash
# First, upload a test file to Drive and note the file ID
# Then publish directly to Pub/Sub:
gcloud pubsub topics publish meeting-transcripts \
  --message='{"fileId":"YOUR_FILE_ID","folderId":"1ijSwEShvWnGV5YtKDgwd7sfRljQMoVuq"}'
```

Check logs:
```bash
gcloud functions logs read processTranscript --region=us-central1 --limit=30
```

### 2.2 Test Chat Bot Responses

Send messages directly to the bot in Google Chat:

| Message | Expected Response |
|---|---|
| `help` | Help text with available commands |
| `status` | Bot status message |
| `tasks` | Interactive cards with pending tasks (or "no pending tasks") |
| `hello` | Pending tasks if any, otherwise welcome message |

### 2.3 Test Chat Bot via curl

```bash
# Test MESSAGE event (simulates user sending "tasks")
curl -X POST https://handlechatinteraction-jrgrpko2qa-uc.a.run.app \
  -H "Content-Type: application/json" \
  -d '{
    "chat": {
      "user": {
        "email": "khalid@k-brands.com",
        "displayName": "Test User"
      },
      "messagePayload": {
        "message": {
          "text": "tasks"
        },
        "space": {
          "name": "spaces/test"
        }
      }
    },
    "commonEventObject": {
      "hostApp": "CHAT"
    }
  }'
```

### 2.4 Test ClickUp Integration

```bash
# Verify ClickUp API connectivity
curl -s "https://api.clickup.com/api/v2/team/8459040/member" \
  -H "Authorization: YOUR_CLICKUP_API_KEY" | python -m json.tool | head -20

# Verify list access
curl -s "https://api.clickup.com/api/v2/list/901802953947" \
  -H "Authorization: YOUR_CLICKUP_API_KEY" | python -m json.tool
```

### 2.5 Test Drive Watcher Setup

```bash
# Full setup (recreates all watchers)
curl -X POST "https://us-central1-meeting-bot-486305.cloudfunctions.net/setupDriveWatchers?mode=full"

# Renew expiring only
curl -X POST "https://us-central1-meeting-bot-486305.cloudfunctions.net/setupDriveWatchers?mode=renew"

# Check logs
gcloud functions logs read setupDriveWatchers --region=us-central1 --limit=10
```

### 2.6 Test Drive Webhook

Simulate a Drive push notification:

```bash
curl -X POST https://us-central1-meeting-bot-486305.cloudfunctions.net/driveWebhook \
  -H "Content-Type: application/json" \
  -H "x-goog-resource-state: change" \
  -H "x-goog-channel-id: meeting-bot-1ijSwEShvWnGV5YtKDgwd7sfRljQMoVuq-test" \
  -H "x-goog-resource-id: test-resource-id"
```

Check logs:
```bash
gcloud functions logs read driveWebhook --region=us-central1 --limit=10
```

---

## 3. Test Fixtures

### Sample Transcript File

Create `test/fixtures/sample-transcript.txt`:

```
Meeting: Weekly Team Standup
Date: 2026-02-03
Participants: Khalid, Ahmed, Sara, Fahad

Khalid: Good morning everyone. Let's start with updates.

Ahmed: I finished the API documentation yesterday. The frontend team needs to review it by Friday.

Sara: I'll handle the review. Also, Fahad, can you update the database schema? We need the new user fields added before next week.

Fahad: Sure, I'll get that done by Wednesday.

Khalid: Great. Sara, please also prepare the quarterly report. It's due by end of month.

Sara: Will do. One more thing - we need someone to look into the performance issues on the dashboard. It's been slow since the last deploy.

Khalid: Ahmed, can you investigate that? Make it a priority.

Ahmed: I'll start on it today. Should have findings by tomorrow.

Khalid: Perfect. Let's also schedule a design review for the new feature. Fahad, can you set that up for next Tuesday?

Fahad: Done. I'll send the invite after this meeting.

Khalid: Thanks everyone. Let's reconvene next Monday.
```

**Expected extracted tasks:**
1. Review API documentation (Sara, due Friday, normal)
2. Update database schema with new user fields (Fahad, due Wednesday, normal)
3. Prepare quarterly report (Sara, due end of month, normal)
4. Investigate dashboard performance issues (Ahmed, high priority)
5. Schedule design review for new feature (Fahad, due next Tuesday, normal)

### Google Meet Format

Create `test/fixtures/sample-google-meet.txt`:

```
Team Meeting - Product Review - Notes by Gemini

2026-02-03 10:00 AM

Khalid Abdulla (10:00 AM)
Let's review the product launch timeline.

Ahmed Hassan (10:02 AM)
The marketing materials are ready. We need Fahad to approve the final designs by Thursday.

Fahad Ali (10:04 AM)
I'll review them today. Action item: Send approved designs to the printer by Friday.

Sara Khan (10:06 AM)
Task for Ahmed: Update the landing page copy with the new tagline.

Khalid Abdulla (10:08 AM)
Also, everyone needs to complete their section of the launch checklist by next Monday.
```

### VTT Format

Create `test/fixtures/sample-meeting.vtt`:

```
WEBVTT

00:00:01.000 --> 00:00:05.000
Khalid: Welcome to the sprint planning.

00:00:06.000 --> 00:00:12.000
Ahmed: I have three items from last sprint that need carryover. Can we assign the API refactoring to Fahad?

00:00:13.000 --> 00:00:20.000
Fahad: Sure. I'll also need Sara to help with the testing. Task: Complete API refactoring and unit tests by next Friday.

00:00:21.000 --> 00:00:28.000
Sara: Got it. I'll create the test plan today and share it with the team.
```

---

## 4. Verifying Task Creation in ClickUp

After clicking "Create Task" in the Chat card:

```bash
# List recent tasks in the target list
curl -s "https://api.clickup.com/api/v2/list/901802953947/task?order_by=created&reverse=true" \
  -H "Authorization: YOUR_CLICKUP_API_KEY" | python -m json.tool | head -50
```

Verify:
- Task name has the correct prefix (e.g. `[Meeting] Review API documentation`)
- Priority is set correctly
- Assignee is mapped to the right ClickUp member
- Due date is set (if suggested)
- Task URL is accessible

---

## 5. Monitoring & Debugging

### View function logs

```bash
# All functions
gcloud functions logs read --region=us-central1 --limit=50

# Specific function
gcloud functions logs read processTranscript --region=us-central1 --limit=30
gcloud functions logs read handleChatInteraction --region=us-central1 --limit=30
gcloud functions logs read setupDriveWatchers --region=us-central1 --limit=30
gcloud functions logs read driveWebhook --region=us-central1 --limit=30

# Filter by severity
gcloud logging read "resource.type=cloud_run_revision AND severity>=WARNING" --limit=20
```

### Check Firestore data

```bash
# List pending tasks
gcloud firestore documents list \
  --collection-ids=pending-tasks \
  --project=meeting-bot-486305

# Check a specific pending task
gcloud firestore documents get \
  projects/meeting-bot-486305/databases/'(default)'/documents/pending-tasks/DOCUMENT_ID
```

### Check Cloud Run service status

```bash
gcloud run services list --region=us-central1
gcloud run services describe handlechatinteraction --region=us-central1
```

### Common issues

| Symptom | Check | Fix |
|---|---|---|
| Bot says "not responding" in Chat | Response format wrong | Ensure `hostAppDataAction` wrapper is used |
| Tasks not extracted | processTranscript logs | Check OpenAI API key, file format support |
| No notification on file upload | Drive watcher expired | Run `setupDriveWatchers?mode=full` |
| ClickUp task creation fails | ClickUp API key / list ID | Verify API key and list `901802953947` exists |
| Button clicks return "Hello" | Event type detection | Check logs for `buttonClickedPayload` vs `messagePayload` |
| Duplicate tasks created | Deduplication check | Verify `isFileAlreadyProcessed` query and Firestore index |

---

## 6. Adding a New Drive Folder

### Step 1: Get the folder ID

Open the Google Drive folder in a browser. The URL will be:
```
https://drive.google.com/drive/folders/FOLDER_ID_HERE
```

### Step 2: Share the folder with the service account

Share the Drive folder with:
```
meeting-task-bot@meeting-bot-486305.iam.gserviceaccount.com
```
Give it **Viewer** access.

### Step 3: Add to `config/folders.json`

```json
{
  "folders": [
    // ... existing folders ...
    {
      "id": "NEW_FOLDER_ID_HERE",
      "name": "Design Team Meetings",
      "taskPrefix": "[Design]",
      "notifyChat": {
        "type": "dm_owner"
      },
      "confidential": false,
      "alwaysNotifyUsers": ["designer@k-brands.com"]
    }
  ]
}
```

### Step 4: Deploy and setup watcher

```bash
cd meeting-task-bot
npm run build

# Redeploy functions that read the config
gcloud functions deploy processTranscript --gen2 --runtime=nodejs20 --region=us-central1 \
  --source=. --entry-point=processTranscript \
  --trigger-topic=meeting-transcripts --memory=512MB --timeout=300s \
  --set-secrets="OPENAI_API_KEY=openai-api-key:latest,CLICKUP_API_KEY=clickup-api-key:latest"

gcloud functions deploy setupDriveWatchers --gen2 --runtime=nodejs20 --region=us-central1 \
  --source=. --entry-point=setupDriveWatchers \
  --trigger-http --allow-unauthenticated --memory=256MB --timeout=120s

gcloud functions deploy driveWebhook --gen2 --runtime=nodejs20 --region=us-central1 \
  --source=. --entry-point=driveWebhook \
  --trigger-http --allow-unauthenticated --memory=256MB --timeout=30s

# Setup watcher for the new folder
curl -X POST "https://us-central1-meeting-bot-486305.cloudfunctions.net/setupDriveWatchers?mode=full"
```

### Step 5: Verify

```bash
# Check watcher was created
gcloud functions logs read setupDriveWatchers --region=us-central1 --limit=10

# Upload a test file to the new folder and check
gcloud functions logs read processTranscript --region=us-central1 --limit=20
```

---

## 7. Notification Routing

| Config | Behavior |
|---|---|
| `notifyChat.type: "dm_owner"` | DM the file owner + `globalNotifyUsers` + `alwaysNotifyUsers` |
| `notifyChat.type: "space"` | Post to the specified Chat space |
| `globalNotifyUsers` | Always notified for ALL folders |
| `alwaysNotifyUsers` | Notified only for that specific folder |
| `confidential: true` | Source quotes redacted from cards |

---

## 8. Cleanup

### Delete test tasks from ClickUp

```bash
curl -X DELETE "https://api.clickup.com/api/v2/task/TASK_ID" \
  -H "Authorization: YOUR_CLICKUP_API_KEY"
```

### Clear pending tasks from Firestore

```bash
# Delete a specific pending task document
gcloud firestore documents delete \
  projects/meeting-bot-486305/databases/'(default)'/documents/pending-tasks/DOCUMENT_ID
```

### Stop all Drive watchers

```bash
# This stops watchers before recreating - use mode=full to reset
curl -X POST "https://us-central1-meeting-bot-486305.cloudfunctions.net/setupDriveWatchers?mode=full"
```
