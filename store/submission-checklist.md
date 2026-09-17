# Submission checklist

## Verified locally

- [x] Manifest V3.
- [x] Minimum Chrome version is 111.
- [x] Manifest summary is within Chrome's 132-character limit.
- [x] Core and optional host permissions are separated.
- [x] Hosted custom endpoints require HTTPS.
- [x] User-selected providers request only their exact host at runtime.
- [x] In-product data disclosure and affirmative consent gate model requests.
- [x] Public homepage and privacy-policy endpoints currently return successfully.
- [x] No remotely hosted executable code or arbitrary JavaScript tool.
- [x] Privacy, permission and reviewer text is prepared.
- [x] Extension tests and ZIP integrity are covered by the local verification workflow.

## Manual before submission

- [ ] Load the unpacked extension in a real Chrome profile.
- [ ] Run one Anthropic turn with a temporary key.
- [ ] Run one local or hosted OpenAI-compatible turn if that provider is advertised.
- [ ] Verify read, chart-change and Pine-confirmation flows on a logged-in TradingView chart.
- [ ] Capture at least one current 1280×800 product screenshot.
- [ ] Upload the 128×128 store icon, 440×280 small promo tile and screenshot.
- [ ] Fill the Dashboard listing and privacy fields from this directory.
- [ ] Publish the updated `PRIVACY.md`, then recheck the public privacy-policy URL.
- [ ] Add temporary reviewer credentials in Test instructions if requested.
- [ ] Enable deferred publishing for the first review.
- [ ] Re-run `npm ci && npm test && npm run package` from a clean tree.
- [ ] Upload the ZIP printed by `tools/package.sh`.
