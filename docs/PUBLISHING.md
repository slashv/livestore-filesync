# Publishing Guide

This guide covers versioning and publishing the `@livestore-filesync/*` packages to npm.

## Packages

| Package | npm Name | Description |
|---------|----------|-------------|
| `packages/core` | `@livestore-filesync/core` | Main file sync functionality |
| `packages/opfs` | `@livestore-filesync/opfs` | OPFS filesystem adapter |
| `packages/r2` | `@livestore-filesync/r2` | Cloudflare R2 handler |
| `packages/s3-signer` | `@livestore-filesync/s3-signer` | S3 signing utilities |

## Prerequisites

### One-time Setup

1. **Create npm account** at https://www.npmjs.com/signup

2. **Create the npm organization** (for scoped packages):
   - Go to https://www.npmjs.com/org/create
   - Create `@livestore-filesync` organization

3. **Authenticate locally**:
   ```bash
   npm login
   ```

4. **Verify authentication**:
   ```bash
   npm whoami
   ```

## Pre-publish Checklist

Before every publish, run these checks:

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Type check
pnpm check

# Run linter
pnpm lint

# Run tests
pnpm test
```

All checks must pass before publishing.

## Versioning

We use **synchronized versioning** - all packages share the same version number to avoid compatibility confusion.

### Bumping Versions

Use pnpm to update versions across all packages:

```bash
# Patch release (0.0.1 -> 0.0.2) - bug fixes
pnpm -r exec npm version patch

# Minor release (0.0.1 -> 0.1.0) - new features, backwards compatible
pnpm -r exec npm version minor

# Major release (0.0.1 -> 1.0.0) - breaking changes
pnpm -r exec npm version major

# Specific version
pnpm -r exec npm version 1.2.3
```

This updates `package.json` in all packages simultaneously.

### Version Guidelines

Follow [Semantic Versioning](https://semver.org/):

- **Patch** (`x.x.1`): Bug fixes, documentation updates, internal refactors
- **Minor** (`x.1.x`): New features, new exports, deprecations (backwards compatible)
- **Major** (`1.x.x`): Breaking API changes, removed features, major refactors

## Publishing

### Dry Run (Recommended First)

Preview what will be published without actually publishing:

```bash
# Dry run for all packages
pnpm -r publish --dry-run --access public
```

Review the output to ensure:
- Correct files are included
- No sensitive files (`.env`, credentials) are included
- Version numbers are correct

### Publish All Packages

```bash
pnpm -r publish --access public
```

The `--access public` flag is required for scoped packages on the free npm tier.

### Publish Individual Package

If you need to publish a single package:

```bash
# Publish only core
pnpm --filter @livestore-filesync/core publish --access public

# Publish only opfs
pnpm --filter @livestore-filesync/opfs publish --access public
```

## Complete Release Workflow

### Step-by-step

```bash
# 1. Ensure you're on main branch with clean working directory
git checkout main
git pull origin main
git status  # Should show no uncommitted changes

# 2. Run all checks
pnpm install
pnpm build
pnpm check
pnpm lint
pnpm test

# 3. Bump version (choose appropriate level)
pnpm -r exec npm version minor

# 4. Commit version bump
git add .
git commit -m "chore: bump version to $(node -p "require('./packages/core/package.json').version")"

# 5. Create git tag
VERSION=$(node -p "require('./packages/core/package.json').version")
git tag -a "v$VERSION" -m "Release v$VERSION"

# 6. Dry run publish
pnpm -r publish --dry-run --access public

# 7. Publish to npm
pnpm -r publish --access public

# 8. Push commits and tags
git push origin main
git push origin "v$VERSION"
```

### Quick Release Script

For convenience, you can run this one-liner after completing checks:

```bash
# Minor release example
pnpm -r exec npm version minor && \
git add . && \
git commit -m "chore: release $(node -p "require('./packages/core/package.json').version")" && \
git tag -a "v$(node -p "require('./packages/core/package.json').version")" -m "Release v$(node -p "require('./packages/core/package.json').version")" && \
pnpm -r publish --access public && \
git push origin main --tags
```

## Troubleshooting

### "You must be logged in to publish"

```bash
npm login
```

### "Package name too similar to existing package"

The npm registry prevents publishing packages with names too similar to existing ones. Check if the name is available:

```bash
npm view @livestore-filesync/core
```

### "Cannot publish over existing version"

You cannot republish the same version. Bump the version number:

```bash
pnpm -r exec npm version patch
```

### "403 Forbidden - Package scope not found"

The organization doesn't exist or you don't have publish access. Ensure:
1. The `@livestore-filesync` org exists on npm
2. Your npm account is a member with publish rights

### Files missing from published package

Check what files will be included:

```bash
cd packages/core
npm pack --dry-run
```

To include/exclude files, add a `files` array to `package.json`:

```json
{
  "files": ["dist", "README.md"]
}
```

## Post-publish Verification

After publishing, verify the packages are available:

```bash
# Check package info
npm view @livestore-filesync/core

# Test installation in a fresh directory
mkdir /tmp/test-install && cd /tmp/test-install
npm init -y
npm install @livestore-filesync/core @livestore-filesync/opfs
```

## Unpublishing (Emergency Only)

If you accidentally publish sensitive data or broken code:

```bash
# Within 72 hours of publish
npm unpublish @livestore-filesync/core@0.0.1
```

Note: npm restricts unpublishing packages that have dependents or are older than 72 hours.

## Future Improvements

When the project matures, consider:

- **Changesets**: Automated versioning and changelogs (https://github.com/changesets/changesets)
- **GitHub Actions**: Automated publishing on release tags
- **Provenance**: npm package provenance for supply chain security
