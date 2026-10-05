Faction Helper v1.2.2

FIXED
- Fixed false "This API key belongs to a player who is not currently in a faction" errors.
- Torn API v2 /key/info wraps key details inside an info object; Faction Helper now handles that current shape correctly.
- Added compatibility with both wrapped and older/unwrapped key-info response shapes.
- Added /user/faction fallback faction detection.
- Added /faction/basic fallback faction-ID detection.
- Faction API Access is now verified by actually testing the protected faction attacks endpoint instead of trusting only one key-info flag.
- New custom API keys also include user/faction for robust faction detection.

CURRENT MEMBER PANEL
- Current last online/action time
- Ranked-war hits and attempts
- Ranked-war success rate
- War respect / score and respect per hit
- Assists, retals, group hits, overseas hits
- Average and maximum fair-fight
- Unique targets
- Organized crimes participated / successful / failed / success rate
- Total Xanax taken during selected period
- Faction Armory Xanax used/taken during selected period
- First/last ranked-war attack
- First/last completed OC
- First/last faction-armory Xanax event

PERIODS
- 1 month
- 3 months
- 6 months (default)
- 12 months

API ACCESS
The player's Torn faction position must have Faction API Access.
The custom API key needs:
- faction/basic
- faction/members
- faction/attacks
- faction/crimes
- faction/news
- user/faction
- user/personalstats
