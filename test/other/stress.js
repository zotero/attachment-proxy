/*
 ***** BEGIN LICENSE BLOCK *****
 
 This file is part of the Zotero Data Server.
 
 Copyright © 2017 Center for History and New Media
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

/**
 * The script tries to stress the attachment-proxy and:
 * - Creates S3 emulator server that provides generated zip files
 * - Runs the actual attachment-proxy server
 * - Runs concurrent workers that constantly download files from a zip file
 */
const http = require('http');
const crypto = require('crypto');
const AWS = require('aws-sdk');
const Throttle = require('throttle');
const JSZip = require('jszip');
const config = require('config');
const request = require('request');

let filesTransferred = 0;
let dataTransferredS3 = 0;
let dataTransferredProxy = 0;

function generateHash() {
	return crypto.randomBytes(16).toString('hex');
}

function getSignedURL(payload, filename) {
	payload = JSON.stringify(payload);
	payload = new Buffer(payload).toString('base64');
	let signature = crypto.createHmac('sha256', config.get('secret')).update(payload).digest('hex');
	return 'http://localhost:' + config.get('port') + '/' + encodeURIComponent(payload) + '/' + signature + '/' + encodeURIComponent(filename);
}

/**
 * S3 emulator server that allows attachment-proxy to use aws-sdk
 * to download a generated zip file
 * @returns {Promise.<void>}
 */
async function startS3EmulatorServer() {
	let zip = new JSZip();
	// Random bytes doesn't compress well, but we want give bigger size for zip too
	// to increase the disk load.
	// I.e. it's possible to fill a file with '0' and have very a small zip,
	// which has a very large file
	
	// Create many files to make attachment-proxy keep more metadata
	// when the zip is mounted
	for (let i = 0; i < 998; i++) {
		zip.file(crypto.randomBytes(10).toString('hex'), crypto.randomBytes(16));
	}
	
	// One big file that is compressed to kilobytes
	// It won't be used, but we want to be sure that only
	// metadata influences memory usage, and not the actual file size
	zip.file('big.txt', (new Buffer(100 * 1024 * 1024).fill('0')));
	
	// The main file that will be downloaded on each request
	zip.file('image.jpg', crypto.randomBytes(1 * 1024 * 1024));
	let buf = await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
	
	// Sends back the previously generated zip file on each request
	// Doesn't matter what is the query url
	function handler(req, res) {
		res.writeHead(200, {
			'content-length': buf.length,
			'content-type': 'application/zip'
		});
		res.write(buf);
		res.end();
		dataTransferredS3 += buf.length;
	}
	
	let server = http.createServer(handler);
	
	await new Promise(function (resolve, reject) {
		server.listen(4000, function (err) {
			if (err) return reject(err);
			resolve();
		});
	});
}

/**
 * Worker that continuously downloads a file from from a zip.
 * Each request forces attachment-proxy to download a new zip
 * from the S3 emulator, store in a sefile,
 * @returns {Promise.<void>}
 */
async function worker() {
	while (1) {
		let url = getSignedURL({
			hash: generateHash(),
			expires: Math.floor(Date.now() / 1000) + 10000,
			zip: 1
		}, 'image.jpg');
		
		await new Promise(function (resolve, reject) {
			// Reduce file transfer speed to 256kb/s
			let stream = new Throttle(256 * 1024);
			request(url).pipe(stream);
			// Allow data to flow and read it to nowhere
			stream.on('data', function (chunk) {
				dataTransferredProxy += chunk.length;
			});
			stream.on('end', function () {
				filesTransferred++;
				resolve();
			});
			stream.on('err', reject);
		});
	}
}

async function start() {
	// Start the S3 emulator that provides zip files
	await startS3EmulatorServer();
	
	// Start the actual attachment-proxy server
	await require('../../server')();
	
	// Start concurrent workers
	let workers = [];
	for (let i = 0; i < 100; i++) {
		workers.push(worker());
	}
	await Promise.all(workers);
}

start();

setInterval(function () {
	let memory = process.memoryUsage();
	console.log(
		'Files from zip: ' + filesTransferred + ',',
		'S3 to attachment-proxy: ' + Math.floor(dataTransferredS3 / 1024 / 1024) + 'mb,',
		'attachment-proxy to client: ' + Math.floor(dataTransferredProxy / 1024 / 1024) + 'mb,',
		'heapTotal: ' +  Math.floor(memory.heapTotal / 1024 / 1024) + 'mb,',
		'heapUsed: ' +  Math.floor(memory.heapUsed / 1024 / 1024) + 'mb,',
		'external: ' +  Math.floor(memory.external / 1024 / 1024) + 'mb'
	);
}, 1000);

setInterval(function () {
	global.gc();
}, 60 * 1000);