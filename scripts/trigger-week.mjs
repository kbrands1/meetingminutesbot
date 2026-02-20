/**
 * Manually trigger processing of transcripts from the past week.
 * Uses gcloud access token for Drive API, then publishes to Pub/Sub.
 */
import { PubSub } from '@google-cloud/pubsub';
import { execSync } from 'child_process';

// Get access token from gcloud (user's own credentials - has Drive access)
const accessToken = execSync('gcloud auth print-access-token').toString().trim();

const pubsub = new PubSub({ projectId: 'meeting-bot-486305' });
const topic = pubsub.topic('meeting-transcripts');

const folders = [
  { id: '1ijSwEShvWnGV5YtKDgwd7sfRljQMoVuq', name: 'Meeting Transcripts' },
  { id: '1yM2r0zfNYy80HPNef18WcR5RQVz9JI0f', name: "Ahsam's Meetings" },
  { id: '1GO1kt_t0QjzNzghy0v70edyspoUwdHqC', name: "Danyal's Meetings" },
  { id: '19YzCp38qemUIHXec6uTRhiS34b1xUlA0', name: "Haseeb's Meetings" },
  { id: '1bwYa2HaTm6lwwtmz9PXEDpA-y1PW0L2T', name: "Khalid's Meetings" },
];

const validExtensions = ['.txt', '.vtt', '.srt', '.docx', '.doc'];
const validMimeTypes = [
  'text/plain',
  'text/vtt',
  'application/vnd.google-apps.document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword'
];

const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
let totalPublished = 0;

async function listFiles(folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false and createdTime > '${oneWeekAgo}'`);
  const fields = encodeURIComponent('files(id,name,mimeType,createdTime)');
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&orderBy=createdTime+desc&pageSize=50`;

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${res.status}: ${err.substring(0, 100)}`);
  }

  const data = await res.json();
  return data.files || [];
}

for (const folder of folders) {
  console.log(`\n📁 ${folder.name}`);

  try {
    const files = await listFiles(folder.id);
    console.log(`   Found ${files.length} files from the past week`);

    for (const file of files) {
      const name = file.name.toLowerCase();
      const isValidExt = validExtensions.some(ext => name.endsWith(ext));
      const isValidMime = validMimeTypes.includes(file.mimeType);

      if (!isValidExt && !isValidMime) {
        console.log(`   ⏭️  Skip (not transcript): ${file.name} [${file.mimeType}]`);
        continue;
      }

      console.log(`   📄 Publishing: ${file.name} (${file.createdTime})`);

      const message = {
        fileId: file.id,
        folderId: folder.id
      };

      await topic.publishMessage({
        data: Buffer.from(JSON.stringify(message))
      });

      totalPublished++;
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (e) {
    console.log(`   ❌ ERROR: ${e.message?.substring(0, 150)}`);
  }
}

console.log(`\n✅ Done! Published ${totalPublished} transcripts to Pub/Sub for processing.`);
