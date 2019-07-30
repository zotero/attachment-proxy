# attachment-proxy

This server allows viewing of attachments in online Zotero libraries. There are two types of attachments supported:

* **Single files (e.g., PDFs):** Streamed directly from S3.
* **Zipped webpage snapshots:** Downloaded from S3 and mounted while user is loading the webpage snapshot. After a while the ZIP file is unmounted and deleted.

### Install

```
git clone https://github.com/zotero/attachment-proxy
cd attachment-proxy
npm install
```
### Configure

```
cp config/sample-config.js config/default.js
```
Configure HMAC `secret` key and S3 `Bucket` (and `accessKeyId` and `secretAccessKey` if not using an IAM role)

### Run

```
npm start
```

### Test

```
npm test
npm run stress
```