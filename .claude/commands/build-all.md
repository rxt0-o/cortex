Build all Cortex subsystems (server + daemon):

```bash
cd server && npm run build && echo "Server built" && cd ../daemon && npm run build && echo "Daemon built"
```

Report which files changed in dist/.
