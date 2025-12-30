# e2e-tests

Framework-agnostic E2E tests for livestore-filesync implementations.

## Overview

This package contains Playwright tests that can be run against any framework implementation (React, Vue, Svelte, etc.) of livestore-filesync. The tests verify the core file sync functionality through the UI.

## Requirements

All framework implementations must include the following `data-testid` attributes:

### Gallery Container
- `data-testid="gallery"` - Main gallery container

### Upload Controls
- `data-testid="upload-button"` - Button to trigger file upload
- `data-testid="file-input"` - File input element (can be hidden)

### File Cards
- `data-testid="file-card"` - Container for each file
- `data-testid="file-image"` - Image preview element
- `data-testid="file-name"` - File name display
- `data-testid="file-status"` - Sync status badge
- `data-testid="delete-button"` - Delete button

### Status Indicators
- `data-testid="status-indicator"` - Online/offline status container
- `data-testid="online-status"` - Online indicator (optional)
- `data-testid="offline-status"` - Offline indicator (optional)

### Loading States
- `data-testid="loading"` - Loading indicator
- `data-testid="empty-state"` - Empty state message

## Usage

### Testing the React Example

```bash
# Start the React dev server
cd examples/web-filesync
pnpm dev

# In another terminal, run tests
cd tests/e2e
pnpm test
```

### Testing with Auto-Start Server

```bash
START_SERVER=1 SERVER_CWD=../../examples/web-filesync pnpm test
```

### Testing Against Different Ports/URLs

```bash
BASE_URL=http://localhost:60004 pnpm test
```

### Auth for Remote Storage Checks

Some tests call the remote file storage endpoint directly. Set `FILESYNC_AUTH_TOKEN` to match your worker auth token (falls back to `VITE_AUTH_TOKEN`, `WORKER_AUTH_TOKEN`, or the default dev token).

### Testing Vue or Other Implementations

```bash
# Start your Vue example
cd examples/vue-filesync
pnpm dev

# Run tests against it
cd tests/e2e
BASE_URL=http://localhost:60005 pnpm test
```

## Test Categories

### File Sync Gallery
- Initial state verification
- File upload functionality
- File display and preview
- File deletion
- Sync status transitions

### Cross-Tab Sync
- Files sync across browser tabs via SharedWorker/OPFS

### Offline Support
- Offline status indication
- Offline file uploads (queued locally)
- Sync when coming back online

### Error Handling
- Graceful handling of failed uploads

### Persistence
- Files persist across page reloads

## Running Specific Tests

```bash
# Run only upload tests
pnpm test --grep "File Upload"

# Run in headed mode for debugging
pnpm test:headed

# Run with UI for interactive debugging
pnpm test:ui

# Debug a specific test
pnpm test:debug --grep "should upload"
```

## CI Integration

```bash
# Install browsers
pnpm exec playwright install

# Run tests in CI mode
CI=1 pnpm test
```

## Writing Tests for New Frameworks

When implementing a new framework adapter:

1. Add the required `data-testid` attributes to your components
2. Run the tests against your implementation:
   ```bash
   BASE_URL=http://localhost:YOUR_PORT pnpm test
   ```
3. Fix any failing tests by ensuring your implementation matches the expected behavior
