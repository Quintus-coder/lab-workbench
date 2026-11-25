# 实验工作台 · Lab Workbench

用于在 Windows 上管理研究项目的文件和计算任务。支持本机试用、邮箱白名单注册与密码登录，也保留 Cloudflare Access 登录模式；可以提交、查看和取消排队任务，尚未接入实际执行器或交互式 PowerShell。

## 启动

在仓库根目录打开 PowerShell，使用 Python 3.10 或更新版本：

```powershell
python main.py
# 或安装后使用模块/命令启动：
python -m pip install .
python -m lab_workbench
```

用浏览器打开 `http://127.0.0.1:8765`，选择试用身份并新建项目。按 Ctrl+C 停止。可通过 `--port` 和 `--data-dir` 指定端口和数据目录。此入口仅面向本机试用，不要将试用登录入口公开至局域网或互联网。

## 邮箱白名单注册与密码登录（本机）

在仓库根目录使用现有 Python 环境。若尚未以开发模式安装，先执行 `python -m pip install -e .`。首次运行先批准管理员邮箱注册（替换示例邮箱）：

```powershell
python -m lab_workbench --password-auth --init-admin lead@school.example
python -m lab_workbench --password-auth
```

打开 `http://127.0.0.1:8765`，点击 **注册账号**，填写已批准的邮箱、密码和确认密码。注册成功后返回登录页，再用邮箱和密码登录。密码为 15–128 个字符；登录页可选择记住此设备 30 天，不勾选时为浏览器会话 Cookie，服务端最多保留 12 小时。显示名称默认使用邮箱前缀，已有成员名称保留。

管理员在右上角用户菜单打开 **成员管理**，输入组员邮箱，点击 **允许注册**。未获准或已停用邮箱无法注册；已注册邮箱不能重复注册或覆盖密码。停用成员会撤销已有会话，保留其文件与任务；恢复待注册成员后重新允许注册。不需要邀请码或邮箱验证码。本模式仅核对邮箱名单，不验证邮箱所有权，知道获准邮箱的人可以先行注册该账号。

此模式默认使用 `.local/password-data/`，与原试用数据 `.local/data/` 分开；不能通过切回试用身份绕过密码。密码使用带随机盐的 scrypt 摘要保存，会话令牌只存摘要。数据库、部署配置都必须留在 Git 外。`--init-admin` 不能覆盖已经设置密码的管理员；本版尚未提供忘记密码自助找回。

### 正式部署：注册验证邮箱，登录使用密码

正式模式必须配置 `GC_BASE_URL`、`GC_ACCESS_ISSUER` 和 `GC_ACCESS_AUDIENCE`，使用 `--production --password-auth --data-dir ...` 启动。Access issuer/audience 对应注册页面的自托管应用。生产注册必须验证 Cloudflare 签发的 JWT（签名、issuer、audience、有效期），并且注册邮箱必须匹配 JWT 邮箱及后台批准名单；不能使用未经验证的邮箱请求头或直接调用接口绕过。仅本机开发模式省略邮箱验证码。

切换现有部署的顺序：

1. 备份数据库、程序及启动脚本，部署新版并在原启动命令中加入 `--password-auth`。保留原 Access issuer/audience、数据目录和 Tunnel 配置。原名单中未停用且尚未设置密码的成员可注册，成员 ID 和项目不变。
2. 在 Cloudflare Zero Trust → Access controls → Applications 中编辑现有自托管应用，将公开主机名的 Path 从空白改为 `register`，最终匹配 `workbench.example.org/register`。保留 One-time PIN、Allow 和既有邮箱规则。不要保留同域名无路径的另一条应用匹配，也不要添加 Bypass 到注册路径。只修改 Access 应用的路径，Tunnel 的公开主机名路径保持空白。若另行创建应用，必须同步更新服务器的 audience。
3. 确认登录页无需 Access 验证，点击注册才进入验证码流程；完成验证后，注册页自动填入已验证邮箱，只需设置并确认密码。注册成功返回登录页，之后使用邮箱和密码登录。有效的 Access 会话可能复用之前的邮箱验证，不一定每次打开注册页都重新发码。
4. 新成员的邮箱须同时获准通过 Access 策略和工作台成员管理。Access 仅核验邮箱；最终能否注册由工作台名单决定。管理员也需要首次通过注册页面设置自己的密码。

注册页面及提交均使用 `/register`，使单个 Access 路径覆盖完整注册操作；旧 `/api/auth/register` 也强制验证同一 JWT。生产注册页面验证到的邮箱不可编辑。验证过期时刷新注册页后重试。先验证未登录的项目和文件接口被拒绝，再缩小 Access 保护范围。真实邮箱收码及完整浏览器登录须在部署后联调。

## 学校邮箱验证码登录（原正式模式）

1. 部署者在 Cloudflare Access 中为工作台域名配置自托管应用，启用 **One-time PIN**，允许指定组员和管理员的邮箱登录；无需自建邮件服务。通过 Tunnel 将该域名接到本机 `http://127.0.0.1:8765`，保留公开域名的 Host。部署时先配置 Access 策略，再开放域名。
2. 用独立数据目录启动应用。以下都是示例，先替换域名、团队地址、应用 Audience 和首位管理员邮箱：

```powershell
$env:GC_BASE_URL = 'https://workbench.example.org'
$env:GC_ACCESS_ISSUER = 'https://your-team.cloudflareaccess.com'
$env:GC_ACCESS_AUDIENCE = 'your-application-audience'
$env:GC_BOOTSTRAP_ADMIN_EMAIL = 'lead@school.example'
python -m lab_workbench --production --data-dir 'D:\GroupCompute\members-data'
```

3. 管理员访问域名，用学校邮箱收码登录，在右上角用户菜单打开 **成员管理** 按完整邮箱添加邀请，再把工作台网址发给组员。邀请不发送邮件；验证码在对方登录时由 Access 发送。Access 允许登录和工作台名单缺一不可。首次管理员仅用于初始化，之后可从启动环境移除该变量。
4. 组员首次登录填写姓名，再次登录直接进入原工作区。管理员可停用与恢复成员；停用阻止后续访问，保留成员 ID、项目和任务。正式模式的退出会使用 Cloudflare Access 退出入口，同一团队的其他 Access 应用也可能需要重新登录。

生产启动前请备份已有数据库。请勿复用试用数据目录、把真实成员名单提交到仓库，或将开发模式暴露到 Tunnel。试点验收使用一名受邀成员的真实学校邮箱，验证收码、注册、退出、重新登录与停用。

## 使用

- 上传文件或文件夹，保留相对目录结构；中断的上传可以继续。可以预览 PDF、下载和删除文件，也可以在网页中编辑小型 UTF-8 文本。
- 选择项目中的 `.py` 或 `.ps1`，将运行参数写在脚本中，点击“保存并提交”。提交时创建独立快照，之后修改项目不会改变已排队任务的输入。
- 在线编辑 `.docx` / `.xlsx` 需要另行部署 ONLYOFFICE Docs，并配置 `GC_OFFICE_URL`、`GC_OFFICE_JWT_SECRET`，按需配置 `GC_OFFICE_CALLBACK_BASE`。未配置时仍可上传和下载。完整 Office 编辑须在实际文档服务部署后联调。

默认数据位于启动目录下的 `.local/data/`。项目原文件按 `files/projects/<成员ID>/<项目ID>/` 存放，SQLite 保存项目和任务记录。运行数据、文档服务密钥和本地配置均不属于源码发行包。

## 开发与打包

```powershell
python -m pip install -e ".[test]"
python -m pytest -q
python -m pip wheel . --no-deps --wheel-dir dist
```

仓库名与 Python 包名统一为 `lab-workbench` / `lab_workbench`，根目录提供 `main.py` 直出启动入口，前端页面模板与静态资源集中在 `lab_workbench/web/`（`templates/`、`static/css/`、`static/js/`）。工作台页面的脚本是原生 ES 模块，无需构建：入口为 `static/js/workbench.js`，`core/` 放请求、状态、主题与通用界面工具，`features/` 按功能（文件、编辑器、上传、任务、项目、成员、登录）划分；`static/css/app.css` 按层叠顺序 `@import` `parts/` 下的分片样式。发布 wheel 时只分发应用包；测试保留在 `tests/`；构建产物与本地运行数据由 `.gitignore` 自动忽略。
