const debug = require('debug')('attachment-proxy');
const Koa = require('koa');
const Router = require('koa-router');
const crypto = require('crypto');
const compress = require('koa-compress');
const mime = require('mime');
const AWS = require('aws-sdk');
const config = require('./config');
const Zip = require('./zip');

const app = new Koa();
const router = new Router();
const s3 = new AWS.S3({
	accessKeyId: config.accessKeyId,
	secretAccessKey: config.secretAccessKey
});

const zips = {};

app.use(async function (ctx, next) {
	try {
		await next()
	} catch (err) {
		ctx.status = err.status || 500;
		console.error('Error handler:', err.message);
	}
});

async function getZip(hash) {
	let zip = zips[hash];
	if (zip) {
		zip.accessed = Date.now();
		return zip;
	}
	
	zip = new Zip();
	await zip.load({
		s3: s3,
		bucket: config.bucket,
		hash: hash,
		tmpFile: './tmp/' + hash
	});
	
	// If another parallel request was faster to load the zip file
	if (zips[hash]) {
		zip.destroy();
		zip = zips[hash];
	} else {
		zips[hash] = zip;
	}
	
	zip.accessed = Date.now();
	return zip;
}

app.use(compress({
	filter: function (content_type) {
		return /text/i.test(content_type)
	},
	threshold: 2048,
	flush: require('zlib').Z_SYNC_FLUSH
}));

router.get('/:payload/:signature/:filename', async function (ctx) {
	let payload = ctx.params.payload;
	let signature = ctx.params.signature;
	let filename = ctx.params.filename;
	
	let computedSignature = crypto.createHmac("sha256", config.secret).update(payload).digest("hex");
	
	if (signature !== computedSignature) {
		ctx.throw(400);
	}
	
	payload = new Buffer(payload, 'base64').toString();
	payload = JSON.parse(payload);
	debug('payload', payload);
	
	if (!payload.expires || !payload.hash) {
		ctx.throw(400);
	}
	
	let t = Math.floor(Date.now() / 1000);
	if (payload.expires <= t) {
		ctx.throw(400);
	}
	
	if (payload.zip) {
		let zip = await getZip(payload.hash);
		try {
			let stream = await zip.get(filename);
			ctx.set('Content-Type', mime.lookup(filename));
			ctx.body = stream;
		} catch (e) {
			ctx.throw(404);
		}
		
	} else {
		if (payload.filename !== filename) {
			return ctx.status = 400;
		}
		
		let stream = s3.getObject({Bucket: config.bucket, Key: payload.hash}).createReadStream();
		stream.on('error', function () {
		
		});
		
		if (payload.contentType) {
			let type = payload.contentType;
			if (payload.charset) {
				type += '; charset=' + payload.charset;
			}
			ctx.type = type;
		}
		
		ctx.body = stream;
	}
});

app
	.use(router.routes())
	.use(router.allowedMethods());

process.on('SIGTERM', function () {
	console.error("Received SIGTERM");
	shutdown();
});

process.on('SIGINT', function () {
	console.error("Received SIGINT");
	shutdown();
});

process.on('uncaughtException', function (err) {
	console.error("Uncaught exception:", err);
	shutdown();
});

process.on("unhandledRejection", function (reason, promise) {
	console.log('Unhandled Rejection at:', promise, 'reason:', reason);
	shutdown();
});

function shutdown() {
	debug('Shutting down');
	for (let hash in zips) {
		let zip = zips[hash];
		debug('Destroying zip:', hash);
		zip.destroy();
	}
	debug('Exiting');
	process.exit();
}

debug("Starting attachment-proxy [pid: " + process.pid + "] on port " + config.port);
app.listen(config.port);

/**
 * Continuously cleans unused zip objects
 */
setInterval(function () {
	let t = Date.now();
	for (let hash in zips) {
		let zip = zips[hash];
		debug('zip', hash, zip.activeStreamNum);
		if (zip.activeStreamNum === 0 && zip.accessed + config.zipCacheTime <= t) {
			debug('Destroying', hash);
			zip.destroy();
			delete zips[hash];
		}
	}
}, 10 * 1000);

