#!/usr/bin/env python3 -I
"""AionUi 2.1.47 网页版静态资源品牌替换 + 界面精简。

用法：python3 -I rebrand.py <原 static 目录> <输出目录> <品牌素材目录> <overlay 目录> <smooth-text.mjs>
只读原目录；输出目录必须不存在。品牌与文案由组织配置提供；可追加第六个参数指定已生成的 skin.json。
"""
import hashlib, json, os, re, shutil, subprocess, sys
from pathlib import Path

src, dst, brand, overlay, smooth_source = sys.argv[1:6]
# The build context supplies a resolved skin; direct runs use the same organization resolver.
if len(sys.argv) > 6:
    skin_file = Path(sys.argv[6])
else:
    import tempfile
    context = tempfile.TemporaryDirectory(prefix='workpartner-skin-')
    materializer = Path(__file__).resolve().parents[2] / 'gateway' / 'organization' / 'materialize-appearance.mjs'
    subprocess.run(['node', str(materializer), context.name], check=True)
    brand = context.name
    skin_file = Path(brand) / 'skin.json'
skin = json.loads(skin_file.read_text())
copy = skin['copy']
BRAND, BRAND_EN = skin['productName']['zh'], skin['productName']['en']
FOOT_1, FOOT_2, TAG_EN = copy['footerTitle'], copy['footerSubtitle'], copy['taglineEn']
THEME_COLOR = skin['themeColor']
WORKDIR = os.environ.get('WP_WORKDIR', '/data/work')
PERMISSION = os.environ.get('WP_PERMISSION', 'bypassPermissions')
if os.path.exists(dst):
    sys.exit('输出目录已存在：' + dst)

# 正文唯一入口；其余补丁仅把显示中的流式标志传到代码组件，排空后恢复原渲染器。
PATCHES = [
    ('r.createElement(pe,{codeStyle:Dt,onLocalFileLink:x},f)',
     'r.createElement(window.wpPacedMarkdown?window.wpPacedMarkdown(i,pe):pe,{key:e.conversation_id+":"+e.msg_id,wpKey:e.conversation_id+":"+e.msg_id,codeStyle:Dt,onLocalFileLink:x},f)'),
    ('onLocalFileLink:d,allowHtml:g,children:m}', 'onLocalFileLink:d,allowHtml:g,wpStreaming:wpStreaming,children:m}'),
    ('code:a=>e.createElement(Ne,{...a,codeStyle:r,hiddenCodeCopyButton:t})',
     'code:a=>e.createElement(Ne,{...a,codeStyle:r,hiddenCodeCopyButton:t,wpStreaming:wpStreaming})'),
    ('}),[r,t,o,d]),y=c.useMemo', '}),[r,t,o,d,wpStreaming]),y=c.useMemo'),
    ('hiddenCodeCopyButton:y,codeStyle:a,...h}=t', 'hiddenCodeCopyButton:y,codeStyle:a,wpStreaming:wpStreaming,...h}=t'),
    ('if(x==="latex"||x==="math"||x==="tex")',
     'if(wpStreaming&&String(l).includes("\\n"))return e.createElement("div",{style:{...a,margin:0,whiteSpace:"pre",overflowX:"auto",maxWidth:"100%",fontFamily:"var(--font-mono)"}},e.createElement("code",{className:o},l));if(x==="latex"||x==="math"||x==="tex")'),
]
# 0.5.0 走查修复：原包中的每段原文必须恰好一处；先检查，再创建输出目录。
UI_PATCHES = [
    # Shared slash-menu surface must remain opaque above conversation content.
    ('style:{borderColor:"var(--color-border-2)",background:"color-mix(in srgb, var(--color-bg-1) 78%, transparent)",backdropFilter:"blur(14px) saturate(1.1)",WebkitBackdropFilter:"blur(14px) saturate(1.1)"}',
     '"data-wp-slash-menu":!0,style:{borderColor:"var(--color-border-2)",background:"var(--wp-card)"}'),
    # Both composers delegate catalog/allowlist and matching to one overlay.
    ('const{input:t,commands:s,onExecuteBuiltin:o,onSelectTemplate:u}=n,c=i.useMemo',
     'const{input:t,commands:wpNative,onExecuteBuiltin:o,onSelectTemplate:u}=n,wpCatalog=window.wpSlashSkills.useCommands(i,wpNative,t),s=wpCatalog.commands,c=i.useMemo'),
    ('xt=/^\\/([a-zA-Z0-9_-]*)$/', 'xt=/^\\/([^\\s/]*)$/'),
    ('s?n.filter(o=>wt(o.name,s)!==null):n', 's?n.filter(o=>window.wpSlashSkills.matches(o,s)):n'),
    ('p=c!==null&&!S&&y.length>0', 'p=c!==null&&!S'),
    ('r.key==="ArrowDown"?(r.preventDefault(),E(v=>(v+1)%y.length),!0)',
     'r.key==="ArrowDown"?(r.preventDefault(),y.length&&E(v=>(v+1)%y.length),!0)'),
    ('r.key==="ArrowUp"?(r.preventDefault(),E(v=>(v-1+y.length)%y.length),!0)',
     'r.key==="ArrowUp"?(r.preventDefault(),y.length&&E(v=>(v-1+y.length)%y.length),!0)'),
    ('query:c,isOpen:p,activeIndex:d,filteredCommands:y', 'query:c,catalogState:wpCatalog.state,isOpen:p,activeIndex:d,filteredCommands:y'),
    ('label:`/${a.name}`,description:a.description,badge:a.hint,highlightIndices:U.query?Rt(a.name,U.query)?.map(I=>I+1):void 0',
     'label:a.wpLabel||`/${a.name}`,description:a.description,badge:a.hint'),
    ('label:`/${a.name}`,description:a.description,badge:a.hint,highlightIndices:ne.query?Dr(a.name,ne.query)?.map(u=>u+1):void 0',
     'label:a.wpLabel||`/${a.name}`,description:a.description,badge:a.hint'),
    ('emptyText:s("messages.slash.empty",{defaultValue:"No commands found"})',
     'emptyText:window.wpSlashSkills.empty(U.query,U.catalogState)'),
    ('emptyText:T("messages.slash.empty",{defaultValue:"No commands found"})})),r.createElement',
     'emptyText:window.wpSlashSkills.empty(ne.query,ne.catalogState)})),r.createElement'),
    ('hint:s("messages.slash.hint",{defaultValue:"Type / to open command menu"})',
     'hint:window.wpSlashSkills.status(U.catalogState)'),
    ('hint:T("messages.slash.hint",{defaultValue:"Type / to open command menu"})',
     'hint:window.wpSlashSkills.status(ne.catalogState)'),
    ('title:s("messages.slash.title",{defaultValue:"Commands"})', 'title:window.wpUI.copy("skills")'),
    ('title:T("messages.slash.title",{defaultValue:"Commands"})', 'title:window.wpUI.copy("skills")'),
    # 聚焦统一交给覆盖层的路由策略；原生 autoFocus 不知道触屏、弹窗和用户操作。
    ('autoFocus:!M,disabled:d,spellCheck:!1',
     'autoFocus:!1,disabled:d,spellCheck:!1'),
    ('t.useEffect(()=>{!s||o||(H.current?.focus(),H.current?.dom.setSelectionRange(c.length,c.length))},[s,c,o]);',
     't.useEffect(()=>{s&&window.wpComposerFocus.request()},[s]);'),
    # Register the overlay-owned page inside the existing authenticated layout.
    ('r.createElement(ve,{path:"/guid",element:Ie(aRo)})',
     'r.createElement(ve,{path:"/market",element:r.createElement("div",{"data-wp-market-host":!0})}),r.createElement(ve,{path:"/guid",element:Ie(aRo)})'),
    # 完成边沿同时收起；历史初始收起，完成后仍能手动展开。
    ('i.useEffect(()=>{t&&s(!0)},[t])',
     'i.useEffect(()=>{s(t)},[t])'),
    ('case"tool_call":return r.createElement(Zo,{message:e})',
     'case"tool_call":return window.wpWebTools.describe(An(e)||{})?r.createElement(ha,{item:An(e)}):r.createElement(Zo,{message:e})'),
    ('case"acp_tool_call":return r.createElement(Hs,{message:e})',
     'case"acp_tool_call":return window.wpWebTools.describe(Jo(e)||{})?r.createElement(ha,{item:Jo(e)}):r.createElement(Hs,{message:e})'),
    # Web tools bypass the generic JSON accordion; hooks still run unconditionally.
    ('E&&_()};return r.createElement("div",{className:"flex flex-col"},f,',
     'E&&_()};const wpWeb=window.wpWebTools.render(r,ae,{...m,status:e.status,truncated:e.truncated&&!o},_);if(wpWeb)return wpWeb;return r.createElement("div",{className:"flex flex-col"},f,'),
    # 两栏共用桌面侧栏宽度 Ho；新版项目键不读取旧的全局宽度记录。
    ('defaultWidth:nPo,minWidth:ua,maxWidth:zm,storageKey:"chat-workspace-width-px"',
     'defaultWidth:Ho,minWidth:ua,maxWidth:zm,storageKey:`wp-workspace-width-v2:${Om()}`'),
    # 原生分栏 hook 切换存储键时重新读取该项目的宽度，不把上一项目带过去。
    ('[c,u]=d.useState(()=>l()),p=d.useCallback',
     '[c,u]=d.useState(()=>l());d.useEffect(()=>{u(l())},[a]);const p=d.useCallback'),
    ('className:"overflow-hidden text-ellipsis whitespace-nowrap"},D)',
     'className:"flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap",title:D},D)'),
    # 标记原生入口，避免把手机标题栏的反馈或其他按钮误认成文件开关。
    ('onClick:L,"aria-label":$}',
     'onClick:L,"data-wp-workspace-trigger":!0,"aria-label":$}'),
    # 原版项目预览宿主 U=!!y&&!a&&S 只渲染桌面；手机复用同一预览组件和状态。
    ('a&&!!y&&r.createElement(XEo,{projectId:y,collapsed:E,onCollapse:_,widthPx:D})',
     'r.createElement(r.Fragment,null,a&&!!y&&r.createElement(XEo,{projectId:y,collapsed:E,onCollapse:_,widthPx:D}),a&&!!y&&S&&r.createElement("div",{className:"wp-mobile-preview",role:"region","aria-label":window.wpUI.copy("filePreview")},r.createElement($To,null)))'),
    ('Ka=({message:e,showCopyRow:t=!0,isLastMessage:n=!1,hasForkAnchor:s=!1})=>',
     'Ka=({message:e,showCopyRow:t=!0,isLastMessage:n=!1,hasForkAnchor:s=!1,wpSource:wpSource})=>'),
    ('(({message:e,showCopyRow:t,isLastMessage:n,hasForkAnchor:s})=>',
     '(({message:e,showCopyRow:t,isLastMessage:n,hasForkAnchor:s,wpSource:wpSource})=>'),
    ('r.createElement(Ka,{message:e,showCopyRow:t,isLastMessage:n,hasForkAnchor:s})',
     'r.createElement(Ka,{message:e,showCopyRow:t,isLastMessage:n,hasForkAnchor:s,wpSource:wpSource})'),
    ('e.hasForkAnchor===t.hasForkAnchor)',
     'e.hasForkAnchor===t.hasForkAnchor&&e.wpSource===t.wpSource)'),
    ('hasForkAnchor:M.has(I.id)})',
     'hasForkAnchor:M.has(I.id),wpSource:I.type==="text"?window.wpMessageActions.sourceMessage(I,t):null})'),
    # 消息操作只接原生草稿恢复和普通发送；两种引擎共用 AcpSendBox。
    ('x=rr(y?.workspace),T=i.useMemo',
     'x=rr(y?.workspace),wpAction=window.wpMessageActions.useAction(i,{message:e,source:wpSource,conversation:y,parse:R=>ja(Ma(R=Ln(R)?Ia(R):R)?Aa(R):R,!0)}),T=i.useMemo'),
    ('!v&&t&&r.createElement("div",{className:F("h-32px flex items-center mt-4px gap-8px",{"flex-row-reverse":u})},M,O,e.created_at',
     't&&r.createElement("div",{className:F("wp-message-actions h-32px flex items-center mt-4px gap-8px",{"flex-row-reverse":u,"wp-message-actions-latest":n&&!u})},M,wpAction,O,e.created_at'),
    ('onClick:J,style:{lineHeight:0}',
     'role:"button",tabIndex:0,"aria-label":l("common.copy",{defaultValue:"Copy"}),onKeyDown:R=>{if(R.key==="Enter"||R.key===" "){R.preventDefault();J()}},onClick:J,style:{lineHeight:0}'),
    ('dt=async r=>{const d=jt(F,O);if(et(),G.emit("acp.selected.file.clear"),Gt(',
     'dt=async(r,wpFiles)=>{const d=wpFiles??jt(F,O);if(wpFiles||(et(),G.emit("acp.selected.file.clear")),Gt('),
    ('await $e({input:r,files:d})},ft=l.useCallback',
     'await $e({input:r,files:d})},wpComposer=window.wpMessageActions.useComposer(l,{id:e,busy:Se||!Ee.hydrated||at,restore:r=>{R(r.input),T(r.files),p([]),G.emit("sendbox.reply.clear")},send:r=>dt(r.input,jt(r.files,[]))}),ft=l.useCallback'),
    # 不传发送按钮前缀，原生发送区便不会生成上下文圆环或预留其位置。
    (',sendButtonPrefix:b?f.createElement(Mn,{tokenUsage:b,context_limit:A,size:24}):void 0', ''),
    # 右键复用“⋮”的触发链，让 Arco 也记录打开状态；仅改 onOpenMenu 会被其鼠标事件关掉。
    ('X=b=>{b.preventDefault(),b.stopPropagation(),ye(),!u&&l(t)}',
     'X=b=>{b.preventDefault(),b.stopPropagation(),ye(),!u&&b.currentTarget.querySelector(`[data-testid="conversation-row-menu-${t.id}"]`)?.click()}'),
    ('return e.createElement(Q,{key:t.id,...G,content:t.name||R("conversation.welcome.newConversation")',
     'r.useEffect(()=>{if(!p)return;const b=h=>{h.key==="Escape"&&(h.preventDefault(),n(t.id,!1))};return document.addEventListener("keydown",b),()=>document.removeEventListener("keydown",b)},[p,n,t.id]);return e.createElement(Q,{key:t.id,...G,content:t.name||R("conversation.welcome.newConversation")'),
    ('description:"输入关键词搜索历史消息，支持分页加载并跳转到对应消息。"',
     'description:"搜索聊过的内容，点结果回到那条消息。"'),
    ('description:"Search historical messages by keyword, load more on scroll, and jump to the matched message."',
     'description:"Find something you discussed. Select a result to return to that message."'),
    ('ot={backgroundColor:"var(--color-aou-1)",boxShadow:"0 0 0 1px var(--color-aou-6-brand) inset",borderRadius:"12px"}',
     'ot={backgroundColor:"var(--wp-active)",boxShadow:"0 0 0 2px var(--wp-focus-line) inset",borderRadius:"12px"}'),
    ('noHistory:"暂无执行记录"', 'noHistory:"暂无对话"'),
    ('noHistory:"No runs yet"', 'noHistory:"No conversations yet"'),
    # 打开文件失败时原生已标 missingFile；不再为它启动元数据轮询或请求快照历史。
    ('if(!R||M.isDirty)return;const I=xt(R);',
     'if(!R||M.isDirty||M.metadata?.missingFile)return;const I=xt(R);'),
    ('const B=v?.metadata?.fileRef?xt(v.metadata.fileRef):void 0;',
     'const B=v?.metadata?.fileRef&&!v.metadata.missingFile?xt(v.metadata.fileRef):void 0;'),
    ('f=d.useMemo(()=>{if(!e)return null;const y=e.metadata,w=y?.file_name||y?.title||e.title;return{contentType:e.content_type,file_path:y?.file_path,workspace:y?.workspace,file_name:w,title:y?.title||e.title,language:y?.language}},[e])',
     'f=d.useMemo(()=>{if(!e||e.metadata?.missingFile||["browser","url"].includes(e.content_type))return null;const y=e.metadata,w=y?.file_name||y?.title||e.title;return{contentType:e.content_type,file_path:y?.file_path,workspace:y?.workspace,file_name:w,title:y?.title||e.title,language:y?.language}},[e?.content_type,e?.title,e?.metadata?.file_path,e?.metadata?.workspace,e?.metadata?.file_name,e?.metadata?.title,e?.metadata?.language,e?.metadata?.missingFile])'),
    # 归档只改变列表投影；搜索和消息读取继续使用后端原来的全部对话。
    ('zn=()=>{pd.getUserConversations.invoke({limit:1e4})',
     'zn=()=>{window.wpArchive.refresh=zn;pd.getUserConversations.invoke({limit:1e4})'),
    ('UPo=(e,t)=>{const n=e.filter(s=>!FPo(s))',
     'UPo=(e,t)=>{window.wpArchive.observe(e);const n=e.filter(s=>!FPo(s)&&s.extra?.wp_archived!==true)'),
    ('onClickMenuItem:b=>{if(b==="pin")',
     'onClickMenuItem:b=>{if(b==="wpArchive"){window.wpArchive.toggle(t);return}if(b==="pin")'),
    ('e.createElement(J.Item,{key:"pin"}',
     'e.createElement(J.Item,{key:"wpArchive"},e.createElement("div",{className:"flex items-center gap-8px"},e.createElement("span",{dangerouslySetInnerHTML:{__html:window.wpArchive.icon}}),e.createElement("span",null,window.wpArchive.label("archive")))),e.createElement(J.Item,{key:"pin"}'),
    ('onClick:b=>{b.stopPropagation()}},e.createElement(Ne,{droplist:',
     'onClick:b=>{b.stopPropagation()}},!N&&e.createElement("button",{type:"button",className:"wp-archive-button sider-action-btn",title:window.wpArchive.label("archive"),"aria-label":window.wpArchive.label("archive"),"data-conversation":t.id,onClick:b=>{b.stopPropagation();window.wpArchive.toggle(t)},dangerouslySetInnerHTML:{__html:window.wpArchive.icon}}),e.createElement(Ne,{droplist:'),
    ('const Vt=new Eg,lu=', 'const Vt=window.wpChatEvents=new Eg,lu='),
    ('},V.conversation.name||l("conversation.historySearch.untitled"))',
     '},window.wpUI.attachmentSummary(V.conversation.name)||l("conversation.historySearch.untitled"))'),
    ('y=Kn(),$=I.length>0,K=P.length>0',
     'y=!1,$=!1,K=!1'),
    (',r.createElement(Fe,{icon:r.createElement(ko,{theme:"outline",size:15,strokeWidth:2.5}),label:i("common.fileAttach.addFiles"',
     ',!1&&r.createElement(Fe,{icon:r.createElement(ko,{theme:"outline",size:15,strokeWidth:2.5}),label:i("common.fileAttach.addFiles"'),

    ('style:{overflowAnchor:"none"},onPointerDown:$,onScroll:N,onWheel:C}',
     'style:{overflowAnchor:"none"},onPointerDown:$,onScroll:N,onKeyDown:e=>{["ArrowUp","PageUp","Home"].includes(e.key)&&$()},onWheel:C}'),
    ('"File(",s.length,")"))):e.createElement(Jt',
     'window.wpUI.fileCount(s.length)))):e.createElement(Jt'),
    ('"File(",s.length,")")))),de&&e.createElement',
     'window.wpUI.fileCount(s.length))))),de&&e.createElement'),

    ('const M=kAo(V.preview_text,h);',
     'const M=kAo(window.wpUI.attachmentSummary(V.preview_text),h);'),
    ('wAo=e=>e?new Intl.DateTimeFormat(void 0,{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(e):""',
     'wAo=e=>e?window.wpUI.dateTime(e):""'),
    ('},U.question),U.answer&&',
     '},window.wpUI.attachmentSummary(U.question)),U.answer&&'),
    ('},U.answer)))}',
     '},window.wpUI.attachmentSummary(U.answer))))}'),
    ('whitespace-nowrap min-w-0"},t.name),A&&',
     'whitespace-nowrap min-w-0"},window.wpUI.attachmentSummary(t.name)),A&&'),
    ('content:t.name||R("conversation.welcome.newConversation")',
     'content:window.wpUI.attachmentSummary(t.name)||R("conversation.welcome.newConversation")'),
    ('className:"absolute right-8px top-1/2 -translate-y-1/2 flex items-center justify-center group-hover:hidden"',
     'className:"wp-unread absolute right-8px top-1/2 -translate-y-1/2 flex items-center justify-center group-hover:hidden"'),
    ('className:D("absolute right-8px top-1/2 -translate-y-1/2 items-center justify-end !collapsed-hidden"',
     'className:D("wp-chat-more absolute right-8px top-1/2 -translate-y-1/2 items-center justify-end !collapsed-hidden"'),
    ('o.map((a,N)=>e.createElement(i.Fragment,{key:a.key}',
     'window.wpUI.uploadEntries(o).map((a,N)=>e.createElement(i.Fragment,{key:a.key}'),

    ('[b,$]=l.useState("manual"),[C,X]=l.useState("09:00")',
     '[b,$]=l.useState("daily"),[C,X]=l.useState("09:00")'),
    ('else u.resetFields(),$("manual"),X("09:00")',
     'else u.resetFields(),$("daily"),X("09:00")'),
    ('t.createElement(E,{label:a("cron.page.form.executionMode")}',
     't.createElement(E,{className:"wp-hide",label:a("cron.page.form.executionMode")}'),
    ('className:"mb-20px flex items-start justify-between gap-16px rounded-12px border border-solid border-[var(--color-border-2)] px-14px py-12px"',
     'className:"wp-hide mb-20px flex items-start justify-between gap-16px rounded-12px border border-solid border-[var(--color-border-2)] px-14px py-12px"'),
    ('O&&t.createElement("div",{className:"mt-16px"},t.createElement(st,{type:"text",onClick:()=>ae',
     'O&&t.createElement("div",{className:"wp-hide mt-16px"},t.createElement(st,{type:"text",onClick:()=>ae'),
    ('ge&&t.createElement("div",{className:"mt-12px grid gap-x-16px gap-y-16px md:grid-cols-2"}',
     'ge&&t.createElement("div",{className:"wp-hide mt-12px grid gap-x-16px gap-y-16px md:grid-cols-2"}'),
    ('de?e.createElement(e.Fragment,null,e.createElement(fe.Item,{key:"file"}',
     'de?e.createElement(e.Fragment,null,e.createElement(fe.Item,{key:"file",className:"wp-hide"}'),
    ('y.length>0&&e.createElement(fe.SubMenu,{key:"skills",',
     '!1&&e.createElement(fe.SubMenu,{key:"skills",'),
    ('label:n("common.fileAttach.addFiles",{defaultValue:"Add files"}),variant:"muted",dividerBefore:!0,onClick:()=>de?ge.current?.click():Ce()',
     'label:window.wpUI.copy("upload"),variant:"muted",dividerBefore:!0,onClick:()=>ge.current?.click()'),
    ('onSelect:R=>E(R)}}),r},[Q,h,b,C,x,g,_,P,w,L,T,D,B,y,F,z,$,v,o,E,se,J,de,Ce,n]',
     'onSelect:R=>E(R)}}),r.filter(entry=>entry.key==="attach")},[Q,h,b,C,x,g,_,P,w,L,T,D,B,y,F,z,$,v,o,E,se,J,de,Ce,n]'),
    ('entries:o.useMemo(()=>c?[{key:"attach",icon:r.createElement(ma,{theme:"outline",size:"16"}),label:s("common.fileAttach.addFiles",{defaultValue:"Add files"}),variant:"muted",dividerBefore:n,onClick:()=>e()}]:[{key:"attach-host-files",icon:r.createElement(fa,{theme:"outline",size:"16"}),label:s("common.fileAttach.addFiles",{defaultValue:"Add files"}),variant:"muted",dividerBefore:n,onClick:()=>e()},{key:"attach-my-device",icon:r.createElement(da,{theme:"outline",size:"16"}),label:s("common.fileAttach.myDevice",{defaultValue:"Upload from device"}),variant:"muted",onClick:()=>m()}],[n,c,e,s,m])',
     'entries:o.useMemo(()=>[{key:"attach-my-device",icon:r.createElement(da,{theme:"outline",size:"16"}),label:window.wpUI.copy("upload"),variant:"muted",dividerBefore:n,onClick:()=>m()}],[n,c,e,s,m])'),
    ('"fileAttach.myDevice":"从设备上传"',
     '"fileAttach.myDevice":"上传文件"'),
    ('"fileAttach.myDevice":"Upload from device"',
     '"fileAttach.myDevice":"Upload files"'),
    ('_V="定时任务",DV=',
     '_V="自动化",DV='),
    ('sF="Scheduled Tasks",iF=',
     'sF="Automation",iF='),
    ('HV={active:"运行中"',
     'HV={active:"已开启"'),
    ('mF={active:"Active"',
     'mF={active:"Enabled"'),
    ('确定要删除此定时任务吗？该任务下的所有会话也将被删除。',
     '删除此自动化后不再自动执行，已生成的对话保留。'),
    ('Are you sure you want to delete this scheduled task? All conversations from this task will also be deleted.',
     'Delete this automation? It will stop running automatically. Existing conversations will be kept.'),
    ('让 AionUi 帮你创建一个定时任务',
     '让AionUi帮你创建一个自动化'),
    # 仅匹配中文 cron 资源中的完整键值；保留其他页面和英文资源。
    ('unconfigured:"未配置定时任务"', 'unconfigured:"未配置自动化"'),
    ('在 AionUi 中创建定时任务。）', '在 AionUi 中新建自动化。）'),
    ('VV="全部定时任务"', 'VV="全部自动化"'),
    ('KV="暂无定时任务"', 'KV="暂无自动化"'),
    ('backToAll:"全部定时任务"', 'backToAll:"全部自动化"'),
    ('scheduledTask:"定时任务"', 'scheduledTask:"自动化"'),
    ('scheduledTaskComplete:"{{title}}的定时任务完成"', 'scheduledTaskComplete:"{{title}}的自动化完成"'),
    ('awakeBanner:"定时任务仅在电脑唤醒状态下运行。"', 'awakeBanner:"自动化仅在电脑唤醒状态下运行。"'),
    ('searchPlaceholder:"搜索定时任务..."', 'searchPlaceholder:"搜索自动化..."'),
    ('noSearchResults:"没有匹配的定时任务。"', 'noSearchResults:"没有匹配的自动化。"'),
    ('createTask:"创建定时任务"', 'createTask:"新建自动化"'),
    ('editTask:"编辑定时任务"', 'editTask:"编辑自动化"'),
    ('scheduleHint:"定时任务会有几分钟的随机延迟以优化服务器性能。"', 'scheduleHint:"自动化会有几分钟的随机延迟以优化服务器性能。"'),
    ('queueHint:"开启后，如果上一次定时任务会话仍在执行，本次触发将直接跳过，不打扰正在工作的助手。"',
     'queueHint:"开启后，如果上一次自动化会话仍在执行，本次触发将直接跳过，不打扰正在工作的助手。"'),
    ('teamTaskExecutionModeLockedReason:"Team 定时任务必须在所属 Team 会话中持续执行，因此不能修改执行模式。"',
     'teamTaskExecutionModeLockedReason:"Team 自动化必须在所属 Team 会话中持续执行，因此不能修改执行模式。"'),
    ('runScheduledTask:"执行定时任务：{{name}}"', 'runScheduledTask:"执行自动化：{{name}}"'),
    ('alreadyExists:\'该会话已存在定时任务 "{{name}}" (ID: {{id}})。请修改现有任务，而不是创建新任务。\'',
     'alreadyExists:\'该会话已存在自动化 "{{name}}" (ID: {{id}})。请修改现有任务，而不是创建新任务。\''),
    ('missedJob:`⏰ 定时任务 "{{name}}" 在系统休眠期间未执行。', 'missedJob:`⏰ 自动化 "{{name}}" 在系统休眠期间未执行。'),
    ('"message.badge":"定时任务"', '"message.badge":"自动化"'),
    ('placeholder:"发送消息到 {{backend}}..."',
     'placeholder:"发消息，或描述要做的事"'),
    ('placeholder:"Send message to {{backend}}..."',
     'placeholder:"Message, or describe what to do"'),
    ('hint:"输入 / 唤起命令，@ 引用文件，↑/↓ 切换历史消息"',
     'hint:""'),
    ('hint:"Type / for commands, @ to reference files, ↑/↓ for message history"',
     'hint:""'),
    ('t&&r.createElement(ke,{size:"mini",type:"text",onClick:f,title:a("preview.openInSystemApp")',
     '!1&&r.createElement(ke,{size:"mini",type:"text",onClick:f,title:a("preview.openInSystemApp")'),
    (',k&&i&&r.createElement("div",{className:C,onClick:f,title:A("preview.openInSystemApp")',
     ',!1&&r.createElement("div",{className:C,onClick:f,title:A("preview.openInSystemApp")'),
    ('!k&&i&&r.createElement("div",{className:C,onClick:f,title:A("preview.openInSystemApp")',
     '!1&&r.createElement("div",{className:C,onClick:f,title:A("preview.openInSystemApp")'),
    ('c&&r.createElement("div",{className:"flex items-center justify-center w-24px h-24px ml-4px rd-4px cursor-pointer flex-shrink-0 hover:bg-bg-3 transition-colors",onClick:c,title:u("preview.browser.newTab")',
     '!1&&r.createElement("div",{className:"flex items-center justify-center w-24px h-24px ml-4px rd-4px cursor-pointer flex-shrink-0 hover:bg-bg-3 transition-colors",onClick:c,title:u("preview.browser.newTab")'),
    ('return l.slice().toSorted(YTo).map(c=>',
     'return l.filter(c=>!window.wpUI.internalFile(c.name,s)).toSorted(YTo).map(c=>'),
    ('function WIo(e){return e?new Date(e).toLocaleString():"-"}',
     'function WIo(e){return e?window.wpUI.dateTime(e):"-"}'),
    ('return`${e.trim()} ${o}-${a}-${s}`}function jIo',
     'return`${e.trim()} ${n.getMonth()+1}月${n.getDate()}日`}function jIo'),
    ('const _=c?`${t("conversation.thinking.complete"',
     'if(c&&!(d>=1000))return null;const _=c?`${t("conversation.thinking.complete"'),
    ('className:`${ce.body} ${u?"":ce.collapsed}`},o)',
     'className:`${ce.body} ${u?"":ce.collapsed}`},r.createElement(pe,null,o))'),
    ('className:"font-medium text-13px"},m.name)',
     'className:"font-medium text-13px"},window.wpUI.toolLabel(m.name))'),
    ('m.description&&m.description!==m.name&&r.createElement("span",{className:"m-l-4px opacity-80 text-13px"},m.description)',
     'window.wpUI.toolSummary(m)&&r.createElement("span",{className:"m-l-4px opacity-80 text-13px"},window.wpUI.toolSummary(m))'),
    ('description:l||s?.command||n.kind,input:o',
     'description:l||window.wpUI.toolDetail(n)||n.kind,input:o'),
    ('!ue&&Math.abs(G)>2&&(_.current||U>=Wt)&&(c.current=!0)',
     '!ue&&G< -2&&_.current&&(c.current=!0)'),
    ('n.scrollTo({top:n.scrollHeight-n.clientHeight,behavior:C}),c.current=!1',
     'n.scrollTo({top:n.scrollHeight-n.clientHeight,behavior:C}),u.current=n.scrollTop,c.current=!1'),
    ('className:"absolute bottom-20px left-50% transform -translate-x-50% z-100"',
     'className:"wp-scroll-bottom"'),
    ('s.useEffect(()=>{!e||i||t||y.current===e||(y.current=e,h.warning(a("conversation.notFound")),o("/",{replace:!0}))},[e,i,t,o,a]),i?r.createElement(te,{loading:!0}):r.createElement(oe,{conversation:t??void 0})',
     'i?r.createElement(te,{loading:!0}):t?r.createElement(oe,{conversation:t}):r.createElement("div",{className:"wp-missing-chat",role:"status"},r.createElement("p",null,window.wpUI.copy("missingChat")),r.createElement("button",{type:"button",onClick:()=>o("/guid",{replace:!0})},window.wpUI.copy("goHome")))'),
    # 普通等待只在消息区显示；启动异常状态和重试入口仍留在输入区。
    ('if(!e?.subject&&!n&&!s)return null;if(!e?.subject&&(n||s))',
     'if(!e?.subject&&!s&&!i)return null;if(!e?.subject&&(n||s))'),
    ('ol=({message:e})=>', 'ol=({message:e,waitingLabel:wpWaitingLabel})=>'),
    ('x.map((S,w)=>r.createElement(r.Fragment,{key:ke(S)||w},Z(w,S))),r.createElement("div",{className:"h-20px"})',
     'x.map((S,w)=>r.createElement(r.Fragment,{key:ke(S)||w},Z(w,S))),window.wpWaiting(r,ol,{conversationId:a?.conversation_id,messages:t,isProcessing:u,rowWidthClass:l}),r.createElement("div",{className:"h-20px"})'),
    ('`${l||t("conversation.thinking.label",{defaultValue:"Thinking..."})} · ${s(p)}`',
     'wpWaitingLabel?wpWaitingLabel(p):`${l||t("conversation.thinking.label",{defaultValue:"Thinking..."})}${p>0?" · "+s(p):""}`'),
]
original_js = [open(os.path.join(r, f), encoding='utf8').read()
               for r, _, fs in os.walk(src) for f in fs if f.endswith('.js')]
for a, _ in PATCHES:
    hits = sum(s.count(a) for s in original_js)
    if hits != 1:
        sys.exit(f'流式补丁原文须恰好命中一次（AionUi 版本变了？）：{hits} 处，{a}')
    print(f'流式补丁锚点：1 处，{a}')

for a, _ in UI_PATCHES:
    hits = sum(s.count(a) for s in original_js)
    if hits != 1:
        sys.exit(f"界面补丁原文须恰好命中一次（AionUi 版本变了？）：{hits} 处，{a}")
    print(f"界面补丁锚点：1 处，{a}")

# 从真实路由解析懒加载模块；hash 或压缩变量名变化不影响预载，路由结构变化则构建失败。
chat_modules = []
chat_styles = []
for source in original_js:
    for route in re.finditer(r'path:"/conversation/:id",element:[\w$]+\(([\w$]+)\)', source):
        module = re.search(r'(?<![\w$])' + re.escape(route[1]) + r'=[\w$]+\.lazy\(\(\)=>[\w$]+\(\(\)=>import\("(\./[^"\n]+\.js)"\),__vite__mapDeps\(\[([\d,]+)\]\)', source)
        if module:
            chat_modules.append('./assets/' + module[1].removeprefix('./'))
            dependencies = re.search(r'm\.f=\[(.*?)\]', source)
            if not dependencies:
                sys.exit('对话路由缺少 Vite 依赖清单')
            paths = json.loads('[' + dependencies[1] + ']')
            for index in map(int, module[2].split(',')):
                if index >= len(paths):
                    sys.exit('对话路由的 Vite 依赖索引越界')
                if paths[index].endswith('.css'):
                    chat_styles.append('./assets/' + paths[index].removeprefix('./'))
if len(chat_modules) != 1 or not os.path.isfile(os.path.join(src, chat_modules[0])):
    sys.exit('对话路由须对应唯一的真实懒加载模块：' + repr(chat_modules))
if not chat_styles or any(not os.path.isfile(os.path.join(src, path)) for path in chat_styles):
    sys.exit('对话路由的样式依赖缺失：' + repr(chat_styles))

# 原样取 旧版后端 的算法、protectedLines 和 repairStreamingMarkdown，只去掉 ESM export；
# createSmoothMarkdown 依赖 旧版后端 的 props，AionUi 的 children/总线适配在 wp-overlay.js。
smooth = open(smooth_source, encoding='utf8').read()
start = 'export class SmoothText {'
end = '/** Create a component once per module, sharing the existing React and Markdown renderer identities. */'
if smooth.count(start) != 1 or smooth.count(end) != 1 or smooth.index(start) >= smooth.index(end):
    sys.exit('smooth-text.mjs 没找到唯一的算法标记（原来的工作伙伴改了？）')
smooth = smooth[smooth.index(start):smooth.index(end)]
for a in ('export class SmoothText', 'export function protectedLines', 'export function repairStreamingMarkdown'):
    if smooth.count(a) != 1:
        sys.exit('smooth-text.mjs 没找到唯一的算法声明：' + a)
    smooth = smooth.replace(a, a.removeprefix('export '))
smooth = copy['streamingComment'] + '\n(() => {\n' + smooth + 'window.WpSmoothText = { SmoothText, protectedLines, repairStreamingMarkdown };\n})();\n'
shutil.copytree(src, dst)

# 1) 文字：AionUi/AionUI -> 工作伙伴；GitHub 仓库地址、wiki 链接里的名字保留
KEEP = [('iOfficeAI/AionUi', '\0K1\0'), ('iofficeai/aionui', '\0K2\0')]
SWAPS = [
    ('命令行 AI 的现代化体验', FOOT_1),
    ('高效且优雅', FOOT_2),
    ('One desktop. Your AI agents, actually coworking.', TAG_EN),
    # 上游此处没有走翻译：读取同一 i18n 实例，随 React 的语言更新一起重绘。
    ('"View Steps "', '(wpLanguage.startsWith("zh")?"查看步骤 ":"View steps ")'),
    ('placeholder:"发消息、上传文件、打开文件夹、创建定时任务，或输入 / 唤起命令..."', 'placeholder:' + json.dumps(copy['homeExample'], ensure_ascii=False)),
    # 对话页右侧“文件 / 变更”栏默认收起（原来的工作伙伴对话页没有这一栏）；本人点开后 AionUi 照常记住“expanded”
    ('localStorage.getItem(Bm(e))==="collapsed"', '(localStorage.getItem(Bm(e))||"collapsed")==="collapsed"'),
    # 首页助手条：手机宽度也把 ChatGPT、Claude 两个按钮都直接显示（AionUi 窄于 460px 时只留一个、其余收进“更多”）
    ('function zs(s){return s>=720?4:s>=600?3:s>=460?2:1}', 'function zs(s){return s>=720?4:s>=600?3:2}'),
    # 首页新建对话：拿到 POST /api/conversations 的返回就跳转，不再先等助手详情、助手列表两个刷新（刷新照常发出，只是不在跳转的路径上）
    ('N&&await Promise.all([Ae(`guid.assistant.detail.${N}.${i}`),Ae("assistants.list")]),qe.emit("chat.history.refresh");const Y={input:c,files:l.length>0?l:void 0};sessionStorage.setItem(`acp_initial_message_',
     'N&&Promise.all([Ae(`guid.assistant.detail.${N}.${i}`),Ae("assistants.list")]).catch(()=>{}),qe.emit("chat.history.refresh");const Y={input:c,files:l.length>0?l:void 0};sessionStorage.setItem(`acp_initial_message_'),
    # 非图片附件复用正文本地文件链接的右侧预览入口；图片保留原生大图预览。
    ('T.length===1?r.createElement("div",{className:"flex items-center"},r.createElement(bt,{path:T[0],onRemove:()=>{},readonly:!0})):r.createElement(Ta,null,T.map(R=>r.createElement(bt,{key:R,path:R,onRemove:()=>{},readonly:!0})))',
     '(wpChip=>T.length===1?r.createElement("div",{className:"flex items-center"},wpChip(T[0])):r.createElement(Ta,null,T.map(wpChip)))(R=>/\\.(jpe?g|png|gif|bmp|webp|svg)$/i.test(R)?r.createElement(bt,{key:R,path:R,onRemove:()=>{},readonly:!0}):r.createElement("div",{key:R,className:"cursor-pointer",onClick:()=>x(R)},r.createElement(bt,{path:R,onRemove:()=>{},readonly:!0})))'),
    # 上传目录已在工作目录内；上传 Office 文件后由本人点击卡片预览。
    ('const{contentType:f}=Fe(p);if(!Ht.has(f))return;',
     'const{contentType:f}=Fe(p);if(!Ht.has(f)||we(p).startsWith(c+"/上传/"))return;'),
]
exts = ('.js', '.html', '.webmanifest')
# 接出原生配置、主题选择和语言切换，不通过被封锁的设置页。
# Web 包仍把主题通知发给桌面 IPC provider（Web 后端没有此 provider），改成同一进程的原生 theme:changed 事件。
bridge = open(os.path.join(overlay, 'wp-settings-bridge.js'), encoding='utf8').read().strip()
native_patches = [
    ('Rbo();ud.languageChanged.on', 'const wpLanguageReady=Rbo();ud.languageChanged.on'),
    ('const Ne=()=>typeof window<"u"&&!!window.electronAPI', bridge + '(Re,cd,zIo,we,Zd,wpLanguageReady);const Ne=()=>typeof window<"u"&&!!window.electronAPI'),
    ('await Sn.setActive.invoke(e)}export{', 'typeof window<"u"&&!window.electronAPI?O.emit("theme:changed",e):await Sn.setActive.invoke(e)}export{'),
    ('ya=({messages:e})=>{const t=Xo(e)', 'ya=({messages:e})=>{const wpLanguage=P().i18n.language,t=Xo(e)'),
]
native_hits = [0] * len(native_patches)
n_files = n_hits = 0
for root, _, files in os.walk(dst):
    for f in files:
        if not f.endswith(exts):
            continue
        p = os.path.join(root, f)
        s = open(p, encoding='utf8').read()
        o = s
        if f.endswith('.js'):
            for i, (a, b) in enumerate(native_patches):
                native_hits[i] += s.count(a)
                s = s.replace(a, b)
        for a, b in KEEP:
            s = s.replace(a, b)
        for a, b in SWAPS:
            s = s.replace(a, b)
        for a, b in PATCHES + UI_PATCHES:
            s = s.replace(a, b)
        n_hits += len(re.findall(r'Aion[Uu][Ii]', s))
        # JS 里英文句子用 WorkPartner，中文句子（前后 12 个字符内有汉字）用中文品牌名
        s = re.sub(r'Aion[Uu][Ii]', (lambda m: BRAND if re.search(r'[\u4e00-\u9fff]', s[max(0, m.start() - 12):m.end() + 12]) else BRAND_EN)
                   if f.endswith('.js') else BRAND, s)
        for a, b in KEEP:
            s = s.replace(b, a)
        if s != o:
            open(p, 'w', encoding='utf8').write(s)
            n_files += 1
print(f'文字替换：{n_files} 个文件，{n_hits} 处')
if native_hits != [1] * len(native_patches):
    sys.exit('AionUi 原生设置补丁未唯一匹配（版本变了？）：' + repr(native_hits))
for a, _ in SWAPS[3:]:
    if not any(a in open(os.path.join(r, f), encoding='utf8').read() for r, _, fs in os.walk(src) for f in fs if f.endswith('.js')):
        sys.exit('界面文字没找到（AionUi 版本变了？）：' + a)

# 2) 图标：登录页/侧栏大图、PWA 图标、favicon、助手图标
def cp(a, b):
    shutil.copyfile(os.path.join(brand, a), os.path.join(dst, b))
import glob
for _f in glob.glob(os.path.join(dst, 'assets', 'app-*.png')):
    shutil.copyfile(os.path.join(brand, 'icon-512.png'), _f)
cp('icon-512.png', 'pwa/icon-512.png')
cp('icon-192.png', 'pwa/icon-192.png')
cp('apple-touch-icon.png', 'pwa/icon-180.png')
cp('favicon.svg', 'favicon.svg')
# 助手图标（ChatGPT、Claude）放 assets/ 下（AionUi 只把 /api/、/assets/ 开头的头像当图片），wp-overlay.js 把界面上原来的 Codex、Claude Code 图标换成这两个
os.makedirs(os.path.join(dst, 'assets', 'wp-agents'))
for _f in ('chatgpt.svg', 'claude.svg'):
    cp(os.path.join('agents', _f), os.path.join('assets', 'wp-agents', _f))

# Organization-owned graphics implement the small host/set/destroy interface used by the overlay.
pet_js = Path(brand, 'wp-pet.js').read_text()
pet_css = Path(brand, 'wp-pet.css').read_text().rstrip() + '\n\n'

# 原包文件名不变，模块内容版本同时进入覆盖层版本，避免覆盖层导入旧模块。
asset_js = sorted(glob.glob(os.path.join(dst, 'assets', '*.js')))
module_version = hashlib.sha256(b''.join(open(f, 'rb').read() for f in asset_js)).hexdigest()[:16]

# 3) index.html：标题、favicon、注入精简脚本
p = os.path.join(dst, 'index.html')
s = open(p, encoding='utf8').read()
s = s.replace('<link rel="icon" type="image/png" href="./pwa/icon-192.png" />',
              '<link rel="icon" type="image/svg+xml" href="./favicon.svg" />')
s = s.replace('<meta name="theme-color" content="#4E5969" />', f'<meta name="theme-color" content="{THEME_COLOR}" />')
css = open(os.path.join(overlay, 'wp-overlay.css'), encoding='utf8').read().replace('__WP_APPEARANCE_NAME__', copy['appearanceName']).replace('__WP_AVATAR_COLOR__', skin['avatarColor']) + '\n' + pet_css
js = open(os.path.join(overlay, 'wp-archive.js'), encoding='utf8').read() + '\n' + open(os.path.join(overlay, 'wp-overlay.js'), encoding='utf8').read().replace('__WP_WORKDIR__', WORKDIR).replace('__WP_PERMISSION__', PERMISSION).replace('  /* __WP_COPY__ */', Path(brand, 'copy.js').read_text().rstrip()).replace('  /* __WP_MODEL_CATALOG__ */', Path(brand, 'models.js').read_text().rstrip()).replace('__WP_WORKDIR__', WORKDIR).replace('__WP_PERMISSION__', PERMISSION)
js = js.replace('__WP_CHAT_MODULE__', chat_modules[0]).replace('__WP_CHAT_STYLES__', json.dumps(chat_styles))
js += '\n' + Path(overlay, 'wp-skills.js').read_text()
skills_zh = json.loads(Path(overlay, '..', '..', 'skills-zh.json').read_text())
js += '\n' + Path(overlay, 'wp-slash-skills.js').read_text().replace('__WP_SKILLS_ZH__', json.dumps(skills_zh, ensure_ascii=False))
web_js = Path(overlay, 'wp-web-tools.js').read_text()
# 覆盖层文件名不带 hash：引用处加内容版本号，浏览器里缓存的旧覆盖层换版本后不会再被用到。
ver = hashlib.sha256((css + pet_js + smooth + js + web_js + module_version).encode()).hexdigest()[:10]
s = s.replace('</head>', f'    <script src="./wp-web-tools.js?v={ver}"></script>\n  </head>')
s = s.replace('</head>', f'    <link rel="stylesheet" href="./wp-overlay.css?v={ver}" />\n    <script src="./wp-pet.js?v={ver}"></script>\n    <script src="./wp-smooth.js?v={ver}"></script>\n    <script src="./wp-overlay.js?v={ver}"></script>\n  </head>')
open(p, 'w', encoding='utf8').write(s)
open(os.path.join(dst, 'wp-web-tools.js'), 'w', encoding='utf8').write(web_js)
open(os.path.join(dst, 'wp-overlay.css'), 'w', encoding='utf8').write(css)
open(os.path.join(dst, 'wp-overlay.js'), 'w', encoding='utf8').write(js)
open(os.path.join(dst, 'wp-pet.js'), 'w', encoding='utf8').write(pet_js)
open(os.path.join(dst, 'wp-smooth.js'), 'w', encoding='utf8').write(smooth)

# 4) manifest
p = os.path.join(dst, 'manifest.webmanifest')
s = open(p, encoding='utf8').read()
s = s.replace('"theme_color": "#4E5969"', f'"theme_color": "{THEME_COLOR}"').replace('AionUI WebUI for mobile and desktop browsers.', copy['manifestDescription'])
open(p, 'w', encoding='utf8').write(s)

# 5) service worker。AionUi 的页面和覆盖层只有 Last-Modified，浏览器按启发式缓存（原版文件是 8 月的，能缓存约 10 天），
# 原 sw.js 虽然先走网络，但 fetch 仍会命中这份 HTTP 缓存，独立窗口和 Safari 强刷也绕不过去。
# 改成：请求一律带 cache: 'no-cache' 先向服务器确认（/assets/ 也一样：上面原地改了其中的文件，文件名 hash 不变）；
# 缓存名升级，激活时删掉旧缓存。
# sw.js 内容一变，浏览器打开页面时就会装上新版，AionUi 原有的激活逻辑会让已打开的窗口自动重新加载。
p = os.path.join(dst, 'sw.js')
s = open(p, encoding='utf8').read()
for a, b in [
    ("const CACHE_NAME = 'aionui-webui-v2';", "const CACHE_NAME = 'workpartner-webui-v2';"),
    ('cache.addAll(PRECACHE_URLS)', "cache.addAll(PRECACHE_URLS.map((u) => new Request(u, { cache: 'no-cache' })))"),
    ('const response = await fetch(request);', "const response = await fetch(request, { cache: 'no-cache' });"),
]:
    if a not in s:
        sys.exit('sw.js 没找到要改的原文（AionUi 版本变了？）：' + a)
    s = s.replace(a, b)
open(p, 'w', encoding='utf8').write(s)

# 原包的模块文件名在品牌补丁后不变。为整个 JS 导入图加内容版本，避免
# 浏览器和 CDN 把上一镜像的模块拼到新页面；不依赖清缓存或 service worker 更新。
module_names = '|'.join(re.escape(os.path.basename(f)) for f in asset_js)
module_ref = re.compile(r'(' + module_names + r')(?=["\'])')
for root, _, files in os.walk(dst):
    for name in files:
        if not name.endswith(('.js', '.html')):
            continue
        target = os.path.join(root, name)
        body = open(target, encoding='utf8').read()
        body = module_ref.sub(lambda m: m[0] + '?wp=' + module_version, body)
        open(target, 'w', encoding='utf8').write(body)
