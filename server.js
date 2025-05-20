/*
 ***** BEGIN LICENSE BLOCK *****
 
 This file is part of the Zotero Data Server.
 
 Copyright © 2018 Center for History and New Media
 George Mason University, Fairfax, Virginia, USA
 http://zotero.org
 
 This program is free software: you can redistribute it and/or modify
 it under the terms of the GNU Affero General Public License as published by
 the Free Software Foundation, either version 3 of the License, or
 (at your option) any later version.
 
 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 GNU Affero General Public License for more details.
 
 You should have received a copy of the GNU Affero General Public License
 along with this program.  If not, see <http://www.gnu.org/licenses/>.
 
 ***** END LICENSE BLOCK *****
 */

const fs = require('fs');
const crypto = require('crypto');
const Koa = require('koa');
const cors = require('@koa/cors');
const Router = require('koa-router');
const compress = require('koa-compress');
const mime = require('mime');
const Netmask = require('netmask').Netmask;
const config = require('config');
const log = require('./log');
const Zip = require('./zip');
const Storage = require('./storage');

const app = new Koa();
const router = new Router();
const storage = new Storage({
	tmpDir: config.get('tmpDir'),
	config: config.get('s3')
});
// Configure CORS for the web library PDF reader
app.use(cors({
	origin: (ctx) => {
		let origin = ctx.get('origin');
		if (origin && origin.endsWith('.zotero.org') || origin.endsWith('.zotero.net')) {
			return ctx.get('origin');
		}
	}
}));

const zips = {};

/**
 * A middleware to catch all errors
 */
app.use(async function (ctx, next) {
	try {
		await next()
	} catch (err) {
		ctx.status = err.status || 500;
		if (err.expose) {
			ctx.message = err.message;
		}
		
		// Be verbose only with internal server errors
		if (err.status) {
			log.warn(err.message);
		} else {
			log.error(err);
		}
	}
});

/**
 * Middleware for logging requests
 */
app.use(async (ctx, next) => {
	let start = Date.now();
	await next();
	let ms = Date.now() - start;
	
	// Apache Combined log format
	let ip = getIP(ctx);
	let user = ctx.state.user || '-';
	let date = formatApacheDate();
	let method = ctx.method;
	let url = ctx.url;
	// Redact full URL
	let urlParts = url.match(/\/[a-z0-9]{50,}\/(.*?)(\.[a-z0-9]{1,20})?$/);
	if (urlParts) {
		let fileBaseName = urlParts[1];
		if (fileBaseName.length > 3) {
			fileBaseName = fileBaseName.substring(0, 3) + "[...]";
		}
		let ext = urlParts[2] || '';
		url = "/[...]/" + fileBaseName + ext;
	}
	let protocol = `HTTP/${ctx.req.httpVersion}`;
	let status = ctx.status;
	let length =
		ctx.state.fileSize // what we stashed earlier
			?? ctx.length // Koa getter if header survived
			?? ctx.response.get('Content-Length') // raw header if compress didn’t run
			?? '-';
	let referer = ctx.get('Referer') || '-';
	let userAgent = ctx.get('User-Agent') || '-';
	
	console.log(`${ip} - ${user} [${date}] "${method} ${url} ${protocol}" ${status} ${length} "${referer}" "${userAgent}" ${ms}ms`);
});

function getIP(ctx) {
	var remoteAddress = ctx.ip;
	if (remoteAddress.startsWith('::ffff:')) {
		remoteAddress = remoteAddress.slice(7);
	}
	try {
		let xForwardedFor = ctx.headers['x-forwarded-for'];
		if (remoteAddress && xForwardedFor) {
			let proxies = config.get('trustedProxies');
			if (Array.isArray(proxies)
					&& proxies.some(cidr => new Netmask(cidr).contains(remoteAddress))) {
				// Extract the left-most IP address from the X-Forwarded-For header
				let forwardedIPs = xForwardedFor.split(',').map(ip => ip.trim());
				if (forwardedIPs.length > 0) {
					remoteAddress = forwardedIPs[0];
				}
			}
		}
	}
	catch (e) {
		log.error(e);
	}
	return remoteAddress;
}

function formatApacheDate(d = new Date()) {
	let pad = (n) => n.toString().padStart(2, '0');
	let day = pad(d.getDate());
	let month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
	let year = d.getFullYear();
	let hours = pad(d.getHours());
	let minutes = pad(d.getMinutes());
	let seconds = pad(d.getSeconds());
	let offset = -d.getTimezoneOffset();
	let sign = offset >= 0 ? '+' : '-';
	let tzHrs = pad(Math.floor(Math.abs(offset) / 60));
	let tzMins = pad(Math.abs(offset) % 60);
	return `${day}/${month}/${year}:${hours}:${minutes}:${seconds} ${sign}${tzHrs}${tzMins}`;
}

/**
 * A middleware to use gzip compression if the file is compressible
 * e.g. has text/html, text/css or similar 'text' content-type,
 * and is at least 2048 bytes size
 *
 * Note: This will only work for text/* files streamed from ZIP archives,
 * because streaming from S3 now provides a Content-Length header which disables compression
 */
app.use(compress({
	filter: function (content_type) {
		return /text/i.test(content_type)
	},
	threshold: 2048,
	flush: require('zlib').Z_SYNC_FLUSH
}));

router.get('/', async function (ctx) {
	ctx.body = '';
});

router.get('/:payload/:signature/:filename', async function (ctx) {
	let payload = ctx.params.payload;
	let signature = ctx.params.signature;
	let filename = ctx.params.filename;
	
	// Some saved websites often try to fetch resources from '../' path,
	// therefore remove signature from url.
	// We try to detect this fast
	if(!/^[0-9A-Fa-f]{64}$/.test(signature)) {
		ctx.throw(400);
	}
	
	// Compare signatures
	let computedSignature = crypto.createHmac("sha256", config.get('secret')).update(payload).digest("hex");
	if (signature !== computedSignature) {
		ctx.throw(400);
	}
	
	// Decode payload
	payload = new Buffer(payload, 'base64').toString();
	payload = JSON.parse(payload);
	log.debug('Payload:', payload);
	if (!payload.expires || !payload.hash) {
		// This can happen only if dataserver generated incorrect url
		ctx.throw(500);
	}
	
	// Validate url expiration
	let t = Math.floor(Date.now() / 1000);
	if (payload.expires <= t) {
		const err = new Error('This URL has expired.');
		err.status = 410;
		err.expose = true;
		throw err;
	}
	
	// If it's a zip, download and mount it
	if (payload.zip) {
		let zip = await getZip(payload.hash);
		let stream = null;
		try {
			stream = await zip.getStream(filename);
		} catch (err) {
			// To keep all http response code logic in server.js
			if (err.code === 'EntryNotFound') {
				err.status = 404;
			}
			throw err;
		}
		// Guess content-type
		ctx.type = mime.getType(filename);
		ctx.body = stream;
	}
	// If it's a regular file just pass-through the stream
	else {
		if (payload.filename !== filename) {
			ctx.throw(404);
		}
		
		// Todo: Guess mime type if it's not set in payload?
		let stream = await storage.getStream(payload.hash);
		if (payload.contentType) {
			let type = payload.contentType;
			if (payload.charset) {
				type += '; charset=' + payload.charset;
			}
			ctx.type = type;
		}

		if (stream.contentLength) {
			ctx.length = stream.contentLength; // sets Content-Length header
			ctx.state.fileSize = stream.contentLength; // keep a copy for logging
		}

		ctx.body = stream;
	}
});

app
	.use(router.routes())
	.use(router.allowedMethods());

/**
 * Get already mounted zip file or download it from S3 and then mount
 * @param hash
 * @returns {Promise.<*>}
 */
async function getZip(hash) {
	let zip = zips[hash];
	if (zip) {
		zip.accessed = Date.now();
		return zip;
	}
	
	let tmpPath = await storage.downloadTmp(hash);
	zip = new Zip();
	await zip.load({
		maxFiles: config.get('zipMaxFiles'),
		maxFileSize: config.get('zipMaxFileSize'),
		hash: hash,
		path: tmpPath
	});
	
	// If another parallel request was faster to load the zip file,
	// we have to destroy our and return the already existing
	if (zips[hash]) {
		log.debug('Destroying a zip in a parallel request', hash);
		zip.destroy();
		fs.unlink(zip.path, err => {});
		zip = zips[hash];
	} else {
		zips[hash] = zip;
	}
	zip.accessed = Date.now();
	return zip;
}

/**
 * Continuously unmounts and deletes unused zip files
 */
setInterval(function () {
	let t = Date.now();
	for (let hash in zips) {
		let zip = zips[hash];
		log.debug('zip', hash, zip.activeStreamNum);
		if (zip.activeStreamNum === 0
			&& zip.accessed + config.get('zipCacheTime') * 1000 <= t) {
			log.debug('Destroying zip', hash);
			zip.destroy();
			
			fs.unlink(zip.path, function (err) {
			});
			
			delete zips[hash];
		}
	}
}, 10 * 1000);

process.on('SIGTERM', function () {
	log.warn("Received SIGTERM");
	shutdown();
});

process.on('SIGINT', function () {
	log.warn("Received SIGINT");
	shutdown();
});

process.on('uncaughtException', function (err) {
	log.error("Uncaught exception:", err);
	shutdown();
});

process.on("unhandledRejection", function (reason, promise) {
	log.error('Unhandled rejection:', promise, 'reason:', reason);
	shutdown();
});

function shutdown() {
	log.info('Shutting down');
	for (let hash in zips) {
		let zip = zips[hash];
		log.debug('Destroying zip:', hash);
		zip.destroy();
		fs.unlink(zip.path, function (err) {
		});
	}
	log.info('Exiting');
	process.exit();
}
// Client connection errors
app.on('error', function (err, ctx) {
	log.debug('App error: ', err, ctx);
});

module.exports = function () {
	log.info("Starting attachment-proxy [pid: " + process.pid + "] on port " + config.get('port'));
	new Promise(resolve => {
		let server = app.listen(config.get('port'), resolve);
		// Set a timeout for disconnecting inactive clients
		server.setTimeout(config.get('connectionTimeout') * 1000);
    });
};
