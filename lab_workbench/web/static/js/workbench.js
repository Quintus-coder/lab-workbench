// Workbench page entry. Modules only declare; wiring runs here in the original registration order.
import { S } from "./core/state.js";
import { initTheme } from "./core/theme.js";
import { guarded, initUi } from "./core/ui.js";
import { initEditor } from "./features/editor.js";
import { initFiles } from "./features/files.js";
import { initJobs, refreshJobs, refreshRelativeTimes } from "./features/jobs.js";
import { initLayout } from "./features/layout.js";
import { initMembers } from "./features/members.js";
import { initProjects } from "./features/projects.js";
import { boot, initSession } from "./features/session.js";
import { refreshSystemStatus } from "./features/status.js";
import { initUploads } from "./features/uploads.js";

initTheme();
// The reading layout's Escape handler must register before the menu Escape handler in initUi.
initLayout();
initUi();
initEditor();
initSession();
initUploads();
initFiles();
initJobs();
initMembers();
initProjects();

guarded(boot)();
setInterval(() => {
  if (S.me && !document.hidden) guarded(refreshJobs)();
}, 4000);
setInterval(() => {
  if (S.me && !document.hidden) {
    refreshRelativeTimes();
    refreshSystemStatus().catch(() => {});
  }
}, 30000);
