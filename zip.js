const debug = require('debug')('attachment-proxy');
const crypto = require('crypto');
const yauzl = require("yauzl");
const fs = require('fs');

let Zip = function () {
	this.maxEntryNum = 5000;
	this.isActive = false;
	this.entries = {};
	this.tmpPath = null;
	this.expires = 0;
	this.zipfile = null;
	this.activeStreamNum = 0;
};

module.exports = Zip;

Zip.prototype.load = function (options) {
	let zip = this;
	let s3 = options.s3;
	return new Promise(function (resolve, reject) {
		// Create a temporary file and store the zip from S3
		
		zip.tmpPath = zip.getTmpPath();
		
		if (!zip.tmpPath) {
			zip.destroy();
			return reject(new Error('Path generation failure'));
		}
		
		let s3Stream = s3.getObject({Bucket: options.bucket, Key: options.hash}).createReadStream();
		let zipStream = fs.createWriteStream(zip.tmpPath);
		
		s3Stream.pipe(zipStream);
		s3Stream.on('end', function () {
			yauzl.open(zip.tmpPath,
				{lazyEntries: true, validateEntrySizes: true, autoClose: false}, function (err, zipfile) {
					if (err) {
						zip.destroy();
						return reject(err);
					}
					
					if (zipfile.entryCount > zip.maxEntryNum) {
						zip.destroy();
						return reject(new Error('Too many entries: ' + zipfile.entryCount));
					}
					
					zip.zipfile = zipfile;
					zipfile.readEntry();
					zipfile.on("entry", function (entry) {
						debug('File entry:', entry.fileName);
						// Ignore directories
						if (entry.fileName.slice(-1) !== '/') {
							let filename = entry.fileName;
							
							if (filename.slice(-5) === '%ZB64') {
								filename = zip.decodeOldFilename(filename);
							}
							
							if (filename) {
								zip.entries[filename] = entry;
							}
						}
						zipfile.readEntry();
					});
					zipfile.on('end', function () {
						zip.isActive = true;
						resolve();
					})
				});
		});
		s3Stream.on('error', function (err) {
			zip.destroy();
			reject(err);
		});
	});
};

Zip.prototype.decodeOldFilename = function (filename) {
	try {
		filename = filename.slice(0, -5);
		filename = new Buffer(filename + 1, 'base64').toString();
		// Todo: Replace deprecated 'escape'. Investigate '%ZB64' encoding.
		filename = escape(filename);
		return decodeURIComponent(filename);
	} catch (e) {
		return null;
	}
};

Zip.prototype.getTmpPath = function () {
	try {
		return './tmp/' + crypto.randomBytes(16).toString('hex');
	} catch (err) {
		return null;
	}
};

Zip.prototype.get = function (filename) {
	let zip = this;
	
	return new Promise(function (resolve, reject) {
		// Check if this Zip object isn't destroyed by cleaner
		if (!zip.isActive) {
			return reject(new Error('Zip object is not active'));
		}
		
		let entry = zip.entries[filename];
		if (!entry) {
			return reject(new Error('Entry not found'));
		}
		
		// Increase active streams number to inform cleaner that this is still in use
		// and prevent destroying this zip
		zip.activeStreamNum++;
		zip.zipfile.openReadStream(entry, function (err, readStream) {
			if (err) {
				zip.activeStreamNum--;
				return reject(err);
			}
			readStream.on('error', function () {
				zip.destroy();
				zip.activeStreamNum--;
			});
			readStream.on('end', function () {
				zip.activeStreamNum--;
			});
			resolve(readStream);
		});
	});
};

Zip.prototype.destroy = function () {
	this.isActive = false;
	if (this.zipfile) {
		this.zipfile.close();
		this.zipfile = null;
	}
	fs.unlink(this.tmpPath, function (err) {
	});
};
