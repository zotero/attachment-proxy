module.exports = {
	logLevel: 'debug',
	// If logFile is not set, then all logs will output to console
	logFile: '',
	port: 3000,
	s3: {
		params: {
			Bucket: ''
		},
		accessKeyId: '',
		secretAccessKey: ''
	},
	// Secret key used to sign a payload with HMAC
	secret: '',
	// How long zip file should be mounted and cached in seconds
	zipCacheTime: 10,
	// Maximum safe count of files and folders in zip file (0 for unlimited)
	zipMaxFiles: 10000,
	// Maximum safe uncompressed file size in bytes (0 for unlimited)
	zipMaxFileSize: 512 * 1024 * 1024,
	// Directory to keep temporary downloaded zip files
	tmpDir: './tmp/'
};