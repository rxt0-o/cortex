Prepare a Cortex plugin release:

1. Run cortex_get_health to check project health
2. Read `.claude-plugin/plugin.json` and `marketplace.json` — show current version
3. Ask user: what is the new version? (patch/minor/major bump?)
4. Update version in both files
5. Run: cd server && npm run build && cd ../daemon && npm run build
6. Show git diff summary
7. Ask user to confirm before committing
8. Commit: `git commit -m "feat: release v<version>"`
