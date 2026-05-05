# TODO – WMS KW Report Rebuild (GSheet)

- [x] Analyze current sync behavior and confirm layout conflict with W20 template tabs
- [ ] Design new standalone KW report tabs (`KWxx_Report`) to avoid touching W20-style operational tabs
- [ ] Implement new report script (KPI summary + top products + top areas per KW)
- [ ] Keep old sync script untouched for now; no writes to existing W20-based tabs
- [ ] Run dry-run/validation for detected weeks and row counts
- [ ] Run real push to target GSheet and create/update `KW19_Report`, `KW20_Report`, `KW26_Report`
- [ ] Verify terminal output and provide import/sync usage instructions (only Transaction_Log as input)
