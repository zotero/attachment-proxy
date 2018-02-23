# attachment-proxy

Allows to view Zotero attachments online. There are two attachment types supported:

* **Regular files.** Streamed directly from S3.
* **Zipped website snapshots.** Downloaded from S3 and mounted while user is loading the website snapshot. After a while the zip file is unmounted and deleted. 

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
Configure HMAC `secret` key, S3 `Bucket`, `accessKeyId` and `secretAccessKey`

### Run

```
npm start
```

### Test

```
npm test
npm run stress
```