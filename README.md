# Lovable GitHub backup helper

I built this tool after getting tired of saving my Lovable projects to GitHub manually. It uses Orca to connect projects and GitHub CLI to verify that the repositories are private and in sync.

The scripts are written for Windows and require Node.js, Orca CLI, GitHub CLI, and an active Lovable browser session. Configure your own GitHub account, Orca workspace, and local project inventory before running them.

The workflow can create GitHub repositories and connect Lovable projects. Review the project inventory and repository changes before use. It backs up source code and repository assets; it does not export databases, uploaded storage, or secrets.

Local inventories, status reports, and logs may contain project names, IDs, and repository details. They are excluded from Git by `.gitignore`. Do not remove those protections or commit those files.
