# Lead Recorder API

Internal REST API for sales agents to manage assigned leads and upload call recordings from Android devices.

## Stack

| Setting | Value |
|---------|-------|
| Database | **MongoDB 7** |
| ODM | **Mongoose** |
| Node.js | **20 LTS** |
| Framework | **Express** |
| S3 provider | **MinIO** (local) / **AWS S3** (production) |
| S3 bucket | `lead-recorder-recordings` |
| S3 region | `ap-south-1` |
| Base API URL (dev) | `http://172.17.51.195:3000` |
| JWT expiry | **7 days** |
| Max upload size | **50 MB** |
| Admin panel (v1) | **No** |

## Quick Start

### Prerequisites

- Node.js 20+
- Docker Desktop (for MongoDB + MinIO)
- npm

### 1. Install

```bash
cd lead_recorder_backend
npm install
cp .env.example .env
```

### 2. Start infrastructure

```bash
docker compose up -d
```

### 3. Seed database

```bash
npm run db:seed
```

### 4. Start API

```bash
npm run dev
```

API: `http://172.17.51.195:3000/api`  
Health: `http://172.17.51.195:3000/health`

### Dev credentials

| Role | Email | Password |
|------|-------|----------|
| Admin | admin@company.com | Admin@123 |
| Manager | manager@company.com | Agent@123 |
| Agent 1 | agent1@company.com | Agent@123 |
| Agent 2 | agent2@company.com | Agent@123 |

## Flutter App

Update `lib/core/config/app_config.dart`:

```dart
static const String apiBaseUrl = 'http://172.17.51.195:3000';
```

## API Endpoints

All protected routes: `Authorization: Bearer <token>`

### Login

```bash
curl -X POST http://172.17.51.195:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"agent1@company.com","password":"Agent@123"}'
```

### Get assigned leads

```bash
curl http://172.17.51.195:3000/api/leads -H "Authorization: Bearer YOUR_TOKEN"
```

### Update lead

```bash
curl -X PATCH http://172.17.51.195:3000/api/leads/LEAD_ID \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"interested","notes":"Wants callback tomorrow"}'
```

### Upload recording

```bash
curl -X POST http://172.17.51.195:3000/api/recordings \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "recording=@/path/to/call.m4a" \
  -F "lead_id=LEAD_ID" \
  -F "phone_number=+919876543210" \
  -F "call_start_time=2026-09-01T10:30:00.000Z" \
  -F "call_end_time=2026-09-01T10:35:22.000Z" \
  -F "duration_seconds=322" \
  -F "source=miuiNative"
```

### Call history

```bash
curl http://172.17.51.195:3000/api/leads/LEAD_ID/calls -H "Authorization: Bearer YOUR_TOKEN"
```

### Presigned playback URL

```bash
curl http://172.17.51.195:3000/api/recordings/RECORDING_ID -H "Authorization: Bearer YOUR_TOKEN"
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `MONGODB_URI` | MongoDB connection string |
| `JWT_SECRET` | Min 16 chars |
| `S3_BUCKET_NAME` | Private bucket for recordings |
| `S3_ENDPOINT` | Set for MinIO; omit for AWS S3 |

## MongoDB Collections

- `users` — agents, managers, admins
- `leads` — lead records
- `leadassignments` — agent ↔ lead mapping
- `callrecordings` — recording metadata (files in S3)
- `auditlogs` — audit trail

Indexes are defined in Mongoose schemas (including dedup on recordings).

## Tests

```bash
npm test
```

Requires MongoDB running (uses `lead_recorder_test` database).

## Project Structure

```
src/
  config/       env, database, s3
  models/       Mongoose schemas
  middleware/   auth, errors, upload
  modules/      auth, leads, recordings, health
  db/           seed script
tests/
```
# Lead-Desk-Backend
