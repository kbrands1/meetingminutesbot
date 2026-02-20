import { google } from 'googleapis';

const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/drive.readonly']
});
const drive = google.drive({ version: 'v3', auth });

const folders = [
  { id: '1ijSwEShvWnGV5YtKDgwd7sfRljQMoVuq', name: 'Meeting Transcripts' },
  { id: '1yM2r0zfNYy80HPNef18WcR5RQVz9JI0f', name: "Ahsam's Meetings" },
  { id: '1GO1kt_t0QjzNzghy0v70edyspoUwdHqC', name: "Danyal's Meetings" },
  { id: '19YzCp38qemUIHXec6uTRhiS34b1xUlA0', name: "Haseeb's Meetings" },
  { id: '1bwYa2HaTm6lwwtmz9PXEDpA-y1PW0L2T', name: "Khalid's Meetings" }
];

const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

for (const folder of folders) {
  try {
    const res = await drive.files.list({
      q: `'${folder.id}' in parents and trashed = false and createdTime > '${oneWeekAgo}'`,
      fields: 'files(id,name,mimeType,createdTime,webViewLink)',
      orderBy: 'createdTime desc',
      pageSize: 20
    });
    const files = res.data.files || [];
    console.log(`\n📁 ${folder.name} (${files.length} files this week):`);
    for (const f of files) {
      console.log(`  ${f.name} | ${f.mimeType} | ${f.createdTime} | ${f.id}`);
    }
  } catch(e) {
    console.log(`\n📁 ${folder.name}: ERROR - ${e.message?.substring(0, 100)}`);
  }
}
