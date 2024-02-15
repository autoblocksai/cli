# Fix Ink Types

All of the new `ink*` packages ship with `package.json`s that don't specify the `types` field.

See:

- https://github.com/vadimdemedes/ink/issues/552
- https://github.com/vadimdemedes/ink/issues/620
- https://github.com/vadimdemedes/ink/pull/579

They suggest updating `tsconfig.json`'s `module` and `moduleResolution` fields to `node16`, but this breaks
the types for other packages (like `hono`), so we patch the `ink*` packages instead.

After running `npm install`, go to each `ink*` package in `node_modules/` and update their `package.json`:

[`ink`](./node_modules/ink/package.json):

```json
{
  "types": "build/"
}
```

[`ink-link`](./node_modules/ink-link/package.json):

```json
{
  "types": "dist/"
}
```

[`ink-spinner`](./node_modules/ink-link/package.json):

```json
{
  "types": "build/"
}
```
