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

const fs = require('fs');
const crypto = require('crypto');
const yauzl = require("yauzl");
const log = require('./log');
const utils = require('./utils');

const Zip = function () {
	// Safety triggers that stop further zip file processing when reached
	this.maxFiles = 0;
	this.maxFileSize = 0;
	this.isActive = false;
	this.entries = {}; // Filename index pointing to entries
	this.path = null;
	this.accessed = 0;
	this.zipfile = null;
	this.activeStreamNum = 0;
};

module.exports = Zip;

/**
 * Download ZIP file from S3, stores it as a temporary file,
 * reads all ZIP entries to memory
 * @param options
 * @returns
 */
Zip.prototype.load = function (options, callback) {
	const zip = this;
	this.maxFiles = options.maxFiles;
	this.maxFileSize = options.maxFileSize;
	this.hash = options.hash;
	this.path = options.path;
	return utils.promisify(function (callback) {
		zip._open(function (err) {
			if (err) {
				zip.destroy();
				return callback(err);
			}
			callback();
		})
	}, callback);
};

Zip.prototype._open = function (callback) {
	let zip = this;
	
	let params = {
		lazyEntries: true,
		validateEntrySizes: true,
		autoClose: false
	};
	
	yauzl.open(zip.path, params, function (err, zipfile) {
		if (err) {
			return callback(err);
		}
		
		zip.zipfile = zipfile;
		
		log.debug('Loading zip file:',
			'filesize=' + Math.round(zip.zipfile.fileSize / 1024 / 1024 * 100) / 100 + 'mb,',
			'entryCount=' + zip.zipfile.entryCount);
		
		let t = Date.now();
		
		if (zip.maxFiles && zip.zipfile.entryCount > zip.maxFiles) {
			return callback(new Error(`Too many entries (${zip.zipfile.entryCount} > ${zip.maxFiles}) in ${zip.hash}`));
		}
		
		// Trigger to read the first entry
		zip.zipfile.readEntry();
		zip.zipfile.on("entry", function (entry) {
			log.debug('File entry found:', entry.fileName);
			zip._processEntry(entry);
			zip.zipfile.readEntry(); // Trigger the next entry
		});
		
		zip.zipfile.on('error', function (err) {
			callback(err);
		});
		
		// After finishing reading entries, zip object becomes ready to use
		zip.zipfile.on('end', function () {
			log.debug(`Zip loaded in ${Date.now()-t}ms`);
			zip.isActive = true;
			callback();
		})
	});
};

Zip.prototype._processEntry = function (entry) {
	let zip = this;
	if (zip.maxFileSize && entry.uncompressedSize > zip.maxFileSize) {
		return callback(new Error(`Uncompressed file is larger than the maximum allowed size (${entry.uncompressedSize} > ${zip.maxFileSize}) in ${zip.hash}`));
	}
	
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
};

Zip.prototype.decodeOldFilename = function (filename) {
	try {
		filename = filename.slice(0, -5);
		filename = new Buffer(filename, 'base64').toString();
		// 'escape' and 'decodeURIComponent' combination successfully decode
		// file names, but find a better way to do this
		// Todo: Replace deprecated 'escape'
		filename = escape(filename);
		return decodeURIComponent(filename);
	} catch (e) {
		return null;
	}
};

/**
 * Gets entry from this.entries filename index and creates a stream,
 * that starts reading and decompressing data from a specific offset in zip file
 * @param filename
 * @returns stream
 */
Zip.prototype.getStream = function (filename, callback) {
	const zip = this;
	return utils.promisify(function (callback) {
		// Check if this Zip object isn't already destroyed by cleaner
		if (!zip.isActive) {
			return callback(new Error('Zip object is not active'));
		}
		
		let entry = zip.entries[filename];
		if (!entry) {
			let err = new Error(`Entry '${filename}' not found in ${zip.hash}`);
			err.code = 'EntryNotFound';
			return callback(err);
		}
		
		// Increase active streams number to inform the cleaner that this is still in use
		// and prevent destroying this zip
		zip.activeStreamNum++;
		zip.zipfile.openReadStream(entry, function (err, readStream) {
			if (err) {
				zip.activeStreamNum--;
				return callback(err);
			}
			readStream.on('error', function () {
				zip.destroy();
				zip.activeStreamNum--;
			});
			readStream.on('end', function () {
				zip.activeStreamNum--;
			});
			callback(null, readStream);
		});
	}, callback);
};

Zip.prototype.destroy = function () {
	this.isActive = false;
	if (this.zipfile) {
		this.zipfile.close();
		this.zipfile = null;
	}
};
