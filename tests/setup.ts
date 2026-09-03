process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-min-16-chars';
process.env.MONGODB_URI =
  process.env.MONGODB_URI ||
  'mongodb://leadrecorder:leadrecorder@localhost:27017/lead_recorder_test?authSource=admin';
process.env.S3_ENABLED = 'true';
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';
process.env.AWS_REGION = 'ap-south-1';
process.env.S3_BUCKET_NAME = 'lead-recorder-recordings';
process.env.S3_ENDPOINT = 'http://localhost:9000';
process.env.MAX_UPLOAD_SIZE_MB = '50';
