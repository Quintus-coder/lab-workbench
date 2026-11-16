# 实验工作台 · Lab Workbench

用于在 Windows 上管理研究项目的文件和计算任务。支持本机试用或通过 Cloudflare Access 使用个人账号；可以提交、查看和取消排队任务，尚未接入实际执行器或交互式 PowerShell。

## 启动

在仓库根目录打开 PowerShell，使用 Python 3.10 或更新版本：

```powershell
python -m pip install .
python -m group_compute
```

用浏览器打开 `http://127.0.0.1:8765`，选择试用身份并新建项目。按 Ctrl+C 停止。可通过 `--port` 和 `--data-dir` 指定端口和数据目录。此入口仅面向本机试用，不要将试用登录入口公开至局域网或互联网。

## 学校邮箱登录（正式模式）

1. 部署者在 Cloudflare Access 中为工作台域名配置自托管应用，启用 **One-time PIN**，允许指定组员和管理员的邮箱登录；无需自建邮件服务。通过 Tunnel 将该域名接到本机 `http://127.0.0.1:8765`，保留公开域名的 Host。部署时先配置 Access 策略，再开放域名。
2. 用独立数据目录启动应用。以下都是示例，先替换域名、团队地址、应用 Audience 和首位管理员邮箱：

```powershell
$env:GC_BASE_URL = 'https://workbench.example.org'
$env:GC_ACCESS_ISSUER = 'https://your-team.cloudflareaccess.com'
$env:GC_ACCESS_AUDIENCE = 'your-application-audience'
$env:GC_BOOTSTRAP_ADMIN_EMAIL = 'lead@school.example'
python -m group_compute --production --data-dir 'D:\GroupCompute\members-data'
```

3. 管理员访问域名，用学校邮箱收码登录，在右上角 **成员管理** 按完整邮箱添加邀请，再把工作台网址发给组员。邀请不发送邮件；验证码在对方登录时由 Access 发送。Access 允许登录和工作台名单缺一不可。首次管理员仅用于初始化，之后可从启动环境移除该变量。
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

仓库名是 `lab-workbench`，Python 模块入口为 `group_compute`。发布 wheel 时只分发应用包；测试保留在源码仓库。仓库采用文件白名单，新增需要版本控制的文件时请同步更新 `.gitignore`。
