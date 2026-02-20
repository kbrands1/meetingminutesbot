/**
 * Manually trigger processing of recent transcripts in all monitored folders.
 * This calls the driveWebhook endpoint to simulate a Drive change notification,
 * which then lists recent files and publishes them to Pub/Sub.
 */

const folders = [
  { id: '1ijSwEShvWnGV5YtKDgwd7sfRljQMoVuq', name: 'Meeting Transcripts' },
  { id: '1yM2r0zfNYy80HPNef18WcR5RQVz9JI0f', name: "Ahsam's Meetings" },
  { id: '1GO1kt_t0QjzNzghy0v70edyspoUwdHqC', name: "Danyal's Meetings" },
  { id: '19YzCp38qemUIHXec6uTRhiS34b1xUlA0', name: "Haseeb's Meetings" },
  { id: '1bwYa2HaTm6lwwtmz9PXEDpA-y1PW0L2T', name: "Khalid's Meetings" }
];

const WEBHOOK_URL = 'https://drivewebhook-jrgrpko2qa-uc.a.run.app';

for (const folder of folders) {
  console.log(`\nTriggering: ${folder.name} (${folder.id})`);

  const channelId = `meeting-bot-${folder.id}-${Date.now()}`;

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-resource-state': 'change',
        'x-goog-channel-id': channelId,
        'x-goog-resource-id': 'manual-trigger'
      }
    });
    console.log(`  Status: ${res.status} ${res.statusText}`);
    const body = await res.text();
    if (body) console.log(`  Response: ${body}`);
  } catch(e) {
    console.log(`  ERROR: ${e.message}`);
  }

  // Small delay between triggers
  await new Promise(r => setTimeout(r, 1000));
}

console.log('\nDone! Check processTranscript logs for processing results.');
