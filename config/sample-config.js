module.exports = {
	logLevel: 'debug',
	// If logFile is empty, then all logs will output to console
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
	// Seconds how long a zip file should be mounted and cached
	zipCacheTime: 60,
	// Maximum safe count of files and folders in a zip file (0 for unlimited)
	zipMaxFiles: 1000,
	// Maximum safe uncompressed file size in bytes (0 for unlimited)
	zipMaxFileSize: 128 * 1024 * 1024,
	// Directory to keep temporary downloaded zip files
	tmpDir: './tmp/',
	// Client connection inactivity timeout in seconds
	connectionTimeout: 30
};
