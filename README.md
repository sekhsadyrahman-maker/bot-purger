# Bot Purger 🛡️

A powerful, serverless moderation tool built for the Reddit Mod Tools Hackathon. 

## The Problem
When spammers, bad-faith actors, or compromised accounts flood a subreddit, moderators are forced to manually hunt down and delete dozens of individual comments and posts. This is a massive drain on moderation teams and leaves communities exposed to toxic content for longer.

## The Solution
Bot Purger adds a highly requested "nuke" button directly into the native Reddit Mod menu. With a single click, moderators can seamlessly batch-remove all of a specific user's content within their subreddit.

### Key Features:
* **One-Click Execution:** Integrated directly into the `comment` and `post` Mod Dropdown menus.
* **Granular Control:** Moderators can choose to purge posts, comments, or both via a native Devvit form.
* **Score Protection:** Protects high-engagement posts by allowing mods to set a "score threshold" (e.g., skip deleting any post with a score above 10).
* **Audit Compliant:** Uses standard `remove()` actions (not hard deletes) so the subreddit's Mod Log accurately reflects the actions for transparency.

## The Technical Architecture
To bypass the strict 30-second serverless execution limits, Bot Purger utilizes an advanced architecture:
* **Recursive Chunking:** Instead of a synchronous loop, the app uses `Devvit.Scheduler` to fetch user content in chunks.
* **Time-Aware Processing:** If the execution time approaches the limit, the app safely saves its pagination cursor to the **Redis KV store**, schedules the next background run immediately, and gracefully terminates. 
* **State Management:** Fully utilizes Redis for state-tracking, ensuring massive purges complete successfully in the background without dropping requests or timing out.

---
*Built using the Devvit Web/Hono architecture for the Reddit Mod Tools Migration Hackathon.*
