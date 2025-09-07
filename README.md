KAISTUDY SYNC for Obsidian
KAISTUDY SYNC is a plugin that safely and intelligently syncs your Obsidian Vault with Google Drive. Going beyond simple file backups, it ensures data integrity by managing multi-device workflows without conflicts, based on a sophisticated algorithm using a 'Master Log' and 'Local Shadow'.

✨ Key Features
Perfect Bidirectional Sync: Flawlessly syncs all changes—creations, modifications, deletions, and even renames and moves of both files and folders—between your local vault and Google Drive.

Intelligent State-Based Algorithm: Assigns a unique ID to every file and folder, recording all change history in a 'Master Log'. This fundamentally solves inefficient issues like "renaming a folder causes all its files to be re-uploaded."

Safe Data Recovery: If a file disappears from Google Drive due to user error or a network issue, the plugin treats it as an accidental loss. During the next sync, it safely restores the file based on your local vault. Deletions are only executed when you explicitly delete a file within your local Obsidian Vault.

Conflict Prevention & Resolution: If a conflict occurs (e.g., editing the same file on two devices simultaneously), it won't overwrite your data. Instead, it safely creates a File (Conflicted Copy YYYY-MM-DD HH-mm-ss).md file, allowing you to merge the changes yourself.

Automatic Sync: You can set a desired interval (in minutes) to automatically run the sync process in the background. (Of course, you can also toggle it On/Off.)

Full Unicode Support: Handles all file and folder names containing Unicode characters without any issues.

🚀 How to Use
In Obsidian, go to Community Plugins and search for KAISTUDY SYNC to install it.

Enable the plugin in your Obsidian settings.

Navigate to the new KAISTUDY SYNC tab in the settings menu.

Click the Connect button and follow the on-screen instructions to authenticate your Google Account. This is a necessary step to keep your data secure.

Once connected, you can start a manual sync anytime by clicking the sync icon (🔄) in the left sidebar.

You can enable automatic sync and set your preferred sync interval (in minutes) in the settings tab.

⚠️ Important Principles
This plugin assumes a sequential work environment. This means you should avoid opening and working on the same vault on multiple devices at the same time. After finishing your work on one device, please run a sync to upload your changes to Google Drive before starting work on another device. Following this principle will keep your data safe.

The .obsidian folder (which contains Obsidian's configuration files) and the .trash folder are always excluded from synchronization.

Developer: JWJ (@charley031204)

This plugin was created with the hope that our precious knowledge will be preserved safely.
