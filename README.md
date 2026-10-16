# QwerNFC printed-sticker compatibility bridge

This **public GitHub Pages repository is not a customer database or development host**.

All current QR/NFC destinations, customer data, app code, and routing snapshots are managed by QwerNFC:
- Private manager/data: `TheNFCGuy/QwerNFC-GReview` (private, `bbmain/docs/qrs.json`)
- Backend: `TheNFCGuy/GReview-Backend` (Cloudflare Worker)
- QwerNFC-owned public router: `TheNFCGuy/TheNFCGuy.github.io` (`main`)

The `permanent-qr-manager/go/QR-XXX/` and `nfc/QR-XXX/` entry pages are **compatibility forwards only**. They hand off to QwerNFC Cloudflare and use the QwerNFC-owned public router for route-data failover. No active mutable QR/NFC route JSON is stored here.

**Never rename, delete, disable GitHub Pages, or remove the original QR/recover entry pages while physical QR stickers remain in service.** Existing stickers encode this GitHub Pages host permanently, and deleting it breaks them.

Legacy Restore pages, Restore artwork, and older APK downloads are retained for already-issued customer links until their replacements are verified.

QR values are immutable and deleted QR IDs are never reused.
