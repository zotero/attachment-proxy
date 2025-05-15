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
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const through2 = require('through2');
const log = require('./log');
const utils = require('./utils');

const Storage = function (options) {
	this.tmpDir = options.tmpDir;
	if (this.tmpDir.slice(-1) !== '/') this.tmpDir += '/';

	let { accessKeyId, secretAccessKey, region, endpoint, s3ForcePathStyle } = options.config;
	this.s3Client = new S3Client(options.config);
	this.bucket = options.config.params.Bucket;
};

module.exports = Storage;

/**
 * Returns S3 file stream
 *
 * @param hash
 * @param callback
 * @returns stream
 */
Storage.prototype.getStream = function (hash, callback) {
	const storage = this;
	return utils.promisify(function (callback) {
		storage.getStreamByKey(hash, function (err, stream) {
			if (err) {
				if (err.name === 'NoSuchKey') {
					storage.getLegacyKey(hash, function (err, key) {
						if (err) return callback(err);
						storage.getStreamByKey(key, function (err, stream) {
							if (err) return callback(err);
							callback(null, stream);
						});
					});
				} else {
					callback(err);
				}
			} else {
				callback(null, stream);
			}
		});
	}, callback);
};

/**
 * If stream data starts flowing, this function returns a stream object,
 * otherwise it returns an error.
 *
 * @param key
 * @param callback
 */
Storage.prototype.getStreamByKey = function (key, callback) {
	const storage = this;
	let streaming = false;
	let stream2 = through2({ highWaterMark: 1 * 1024 * 1024 },
		function (chunk, enc, next) {
			if (!streaming) {
				streaming = true;
				callback(null, stream2);
			}
			this.push(chunk);
			next();
		}
	);

	// Use GetObjectCommand to read from S3
	const command = new GetObjectCommand({
		Bucket: this.bucket,
		Key: key,
	});

	storage.s3Client.send(command).then((response) => {
		stream2.contentLength = response.ContentLength;
		response.Body.pipe(stream2);
	}).catch((err) => {
		if (streaming) {
			stream2.emit('error', err);
		} else {
			callback(err);
		}
	});
};

/**
 * Try to get a legacy S3 key
 * @param hash
 * @param callback
 */
Storage.prototype.getLegacyKey = function (hash, callback) {
	const storage = this;
	const command = new ListObjectsV2Command({
		MaxKeys: 1,
		Prefix: hash,
	});

	storage.s3Client.send(command).then((data) => {
		if (Array.isArray(data.Contents) && data.Contents[0] && data.Contents[0].Key) {
			callback(null, data.Contents[0].Key);
		} else {
			callback(new Error('No S3 key found'));
		}
	}).catch((err) => {
		callback(err);
	});
};

Storage.prototype.getTmpPath = function () {
	try {
		return this.tmpDir + 'ztmp_' + crypto.randomBytes(16).toString('hex');
	} catch (err) {
		return null;
	}
};

Storage.prototype.downloadTmp = function (hash, callback) {
	const storage = this;
	return utils.promisify(function (callback) {
		storage.getStream(hash, function (err, s3Stream) {
			if (err) return callback(err);
			let tmpPath = storage.getTmpPath();
			if (!tmpPath) return callback(new Error('Error generating a tmp file path'));
			
			let tmpStream = fs.createWriteStream(tmpPath);
			
			// Multiple streams can theoretically simultaneously emit errors,
			// therefore we have to prevent repeated callback calls
			let _callback = function () {
				_callback = function () {
				};
				
				// Delete the temporary file if one or another stream fails
				fs.unlink(tmpPath, function (err) {
				});
				callback.apply(this, arguments);
			};
			
			tmpStream.on('error', function (err) {
				_callback(err)
			});
			s3Stream.on('error', function (err) {
				_callback(err)
			});
			
			tmpStream.on('finish', function () {
				callback(null, tmpPath);
			});
			
			s3Stream.pipe(tmpStream);
		});
	}, callback);
};
