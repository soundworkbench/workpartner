/** Standalone feedback UI. All user-provided strings are rendered through textContent. */
export function feedbackPage({ appearanceStyle = '', maxImageBytes = 5242880, maxImagesPerItem = 6 } = {}) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>反馈 · 工作伙伴</title>
<style>
[hidden]{display:none!important}*{box-sizing:border-box}body{margin:0;background:#f5f5f5;color:#222;font:16px/1.6 system-ui,"Microsoft YaHei",sans-serif}main{max-width:800px;margin:32px auto;padding:0 16px}h1{font-size:28px}h2{font-size:21px;margin:0 0 12px}h3{margin:8px 0}section{background:white;border:1px solid #ddd;border-radius:16px;padding:20px;margin:18px 0;min-width:0}p{overflow-wrap:anywhere}label{display:block;margin:10px 0}fieldset{border:0;padding:0;margin:0;min-width:0}fieldset label{display:inline-block;margin-right:16px}input[type=text],textarea{display:block;width:100%;min-width:0;border:1px solid #aaa;border-radius:8px;padding:10px;font:inherit}textarea{min-height:120px;resize:vertical}input[type=file]{width:100%;font:inherit}button,a.button{border:0;border-radius:8px;padding:10px 16px;min-height:44px;background:#333;color:white;font:inherit;cursor:pointer;max-width:100%;overflow-wrap:anywhere}button.secondary{background:#eee;color:#333}button:disabled{opacity:.5;cursor:wait}button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid #777;outline-offset:3px}a{color:#333}.muted{color:#666;font-size:14px}.error{color:#a32336;white-space:pre-wrap;overflow-wrap:anywhere}.text{white-space:pre-wrap;overflow-wrap:anywhere}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.list{display:grid;gap:10px}.entry{display:block;width:100%;text-align:left;background:#f6f6f6;color:#222}.entry strong{display:block;overflow-wrap:anywhere}.badge{display:inline-block;font-size:13px;padding:2px 8px;border-radius:12px;background:#e9edf0;color:#334}.badge[data-status=done]{background:#dff1e4;color:#275f39}.badge[data-status=need_info],.badge[data-status=pending_approval]{background:#fff0ca;color:#715800}.thumbs{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0}.thumb{width:120px;min-width:0;overflow-wrap:anywhere}.thumb img{width:120px;height:90px;object-fit:contain;border:1px solid #ddd;border-radius:6px}.thumb button{width:100%;padding:6px}.screenshots img{max-width:100%;max-height:220px;object-fit:contain}.screenshots a{display:inline-block;max-width:100%;margin:4px}.comment{border-top:1px solid #ddd;padding-top:10px;margin-top:10px}#detail{scroll-margin-top:16px}#detail a{overflow-wrap:anywhere}@media(max-width:400px){main{padding:0 12px;margin:20px auto}section{padding:14px}.row button{flex:1}}
${appearanceStyle}
</style>
<main><h1>反馈</h1><p class="muted">遇到问题，或有新的需求？告诉我们，也可以在这里查看进展、补充信息。</p>
<section><h2>提交反馈</h2><form id="submit-form"><fieldset id="draft-fields"><legend>反馈类型</legend><label><input type="radio" name="type" value="bug" checked> 问题</label><label><input type="radio" name="type" value="feature"> 需求</label>
<label>标题<input id="title" type="text" maxlength="120" required></label><label>描述<textarea id="body" maxlength="8000" required placeholder="请描述遇到的问题、复现步骤，或你希望实现的需求"></textarea></label></fieldset>
<label>截图（PNG / JPEG / WebP）<input id="screenshots" type="file" accept="image/png,image/jpeg,image/webp" multiple></label><p class="muted">可在此表单中粘贴截图；每张最多 ${Math.round(maxImageBytes / 1024 / 1024 * 10) / 10} MB，每条最多 ${maxImagesPerItem} 张。</p><div id="previews" class="thumbs"></div><button id="submit" type="submit">提交反馈</button><p id="submit-message" role="status" class="error"></p></form></section>
<section><div class="row"><h2 id="list-title">我的反馈</h2><button id="scope" class="secondary" hidden>全部反馈</button><button id="refresh" class="secondary">刷新</button></div><div id="list" class="list"></div><p id="list-error" class="error" role="alert"></p></section>
<section id="detail" hidden></section></main>
<script>
const API='/_wp/api/feedback', maxBytes=${maxImageBytes}, maxImages=${maxImagesPerItem};
const labels={open:'已提交',need_info:'待补充',pending_approval:'需求待审批',in_progress:'处理中',done:'已完成',rejected:'不做',duplicate:'重复'};
const types={bug:'问题',feature:'需求'}, approvalLabels={none:'无需审批',pending:'待审批',approved:'已批准',rejected:'未批准'};
const el=id=>document.getElementById(id);
const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const date=value=>new Date(value).toLocaleString('zh-CN');
const badge=item=>{const n=node('span',labels[item.status]||item.status,'badge');n.dataset.status=item.status;return n;};
let all=false, pending=[], pendingItem=null, busy=false, previewUrls=[], detailUrls=[], detailVersion=0;
async function api(route='',method='GET',body,raw=false){
  const r=await fetch(API+route,{method,credentials:'same-origin',headers:method==='POST'?{'content-type':raw?'application/octet-stream':'application/json'}:{},body:body===undefined?undefined:raw?body:JSON.stringify(body)});
  let data;try{data=await r.json();}catch{data={};}
  if(!r.ok)throw new Error(data.error||(r.status===404?'反馈不存在或暂未开放。':'暂时无法处理，请稍后重试。'));
  return data;
}
function previews(){
  previewUrls.forEach(url=>URL.revokeObjectURL(url));previewUrls=[];el('previews').replaceChildren();
  pending.forEach((file,index)=>{const box=node('div',undefined,'thumb'),img=node('img');const url=URL.createObjectURL(file);previewUrls.push(url);img.src=url;img.alt=file.name||'待上传截图';
    const remove=node('button','删除','secondary');remove.type='button';remove.disabled=busy;remove.onclick=()=>{if(busy)return;pending.splice(index,1);previews();};box.append(img,remove);el('previews').append(box);});
}
function addFiles(files){
  if(busy)return;
  try{for(const file of files){if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('截图只支持 PNG、JPEG 或 WebP 图片。');if(file.size>maxBytes)throw new Error('截图过大，请选择更小的图片。');if(pending.length+(pendingItem?.files.length||0)>=maxImages)throw new Error('每条反馈最多上传 '+maxImages+' 张截图。');pending.push(file);}el('submit-message').textContent='';}catch(e){el('submit-message').textContent=e.message;}previews();
}
el('screenshots').onchange=e=>{addFiles([...e.target.files]);e.target.value='';};
el('submit-form').addEventListener('paste',e=>{const files=[...(e.clipboardData?.items||[])].filter(i=>i.kind==='file').map(i=>i.getAsFile()).filter(Boolean);if(files.length){e.preventDefault();addFiles(files);}});
async function list(){
  try{const data=await api(all?'?scope=all':'');el('scope').hidden=!data.isHandler;el('list-title').textContent=all?'全部反馈':'我的反馈';el('scope').textContent=all?'我的反馈':'全部反馈';el('list').replaceChildren();
    if(!data.items.length)el('list').append(node('p','还没有反馈。','muted'));
    data.items.forEach(item=>{const button=node('button',undefined,'entry');button.append(node('strong','#'+item.no+' · '+types[item.type]+' · '+item.title),badge(item),node('div','更新于 '+date(item.updatedAt),'muted'));button.onclick=()=>{if(location.hash==='#'+item.id)openDetail();else location.hash=item.id;};el('list').append(button);});el('list-error').textContent='';
  }catch(e){el('list-error').textContent=e.message;}
}
async function openDetail(){
  el('detail').onpaste=null;detailUrls.forEach(url=>URL.revokeObjectURL(url));detailUrls=[];
  const key=location.hash.slice(1),version=++detailVersion,section=el('detail');
  if(!key){section.hidden=true;return;}
  section.hidden=false;section.replaceChildren(node('p','正在加载…'));
  try{const data=await api('/items/'+encodeURIComponent(key));if(version!==detailVersion)return;const item=data.item;
    section.replaceChildren(node('h2','#'+item.no+' · '+types[item.type]+' · '+item.title),badge(item),node('p',item.author.name+' · '+date(item.createdAt),'muted'),node('p',item.body,'text'));
    if(item.typeChangedFrom)section.append(node('p','此反馈已从问题调整为需求。','muted'));
    if(item.approval.state!=='none')section.append(node('p',approvalLabels[item.approval.state]+(item.approval.note?'：'+item.approval.note:''),'text'));
    if(item.pr){const a=node('a','查看 PR');a.href=item.pr;a.target='_blank';a.rel='noopener noreferrer';section.append(a);}
    const images=node('div',undefined,'screenshots');
    const showImages=files=>{images.replaceChildren();files.forEach(file=>{const a=node('a'),img=node('img');a.href=API+'/items/'+item.id+'/files/'+file.id;a.target='_blank';a.rel='noopener noreferrer';img.src=a.href;img.alt=file.name;img.loading='lazy';a.append(img);images.append(a);});};
    showImages(item.files);section.append(images);
    if(data.canUpload&&item.files.length<maxImages){
      const label=node('label','补充截图'),input=node('input'),queue=node('div',undefined,'thumbs'),upload=node('button','上传截图'),message=node('p','','error');
      input.type='file';input.accept='image/png,image/jpeg,image/webp';input.multiple=true;label.append(input);message.setAttribute('role','status');
      let files=[],stored=item.files,uploading=false;upload.disabled=true;
      const renderQueue=()=>{detailUrls.forEach(url=>URL.revokeObjectURL(url));detailUrls=[];queue.replaceChildren();
        files.forEach((file,index)=>{const box=node('div',undefined,'thumb'),img=node('img'),remove=node('button','删除','secondary');const url=URL.createObjectURL(file);detailUrls.push(url);img.src=url;img.alt=file.name;remove.disabled=uploading;remove.onclick=()=>{if(uploading)return;files.splice(index,1);renderQueue();};box.append(img,remove);queue.append(box);});upload.disabled=uploading||!files.length;};
      const select=selected=>{if(uploading)return;try{for(const file of selected){if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('截图只支持 PNG、JPEG 或 WebP 图片。');if(file.size>maxBytes)throw new Error('截图过大，请选择更小的图片。');if(files.length+stored.length>=maxImages)throw new Error('每条反馈最多上传 '+maxImages+' 张截图。');files.push(file);}message.textContent='';}catch(e){message.textContent=e.message;}renderQueue();};
      input.onchange=()=>{select([...input.files]);input.value='';};
      section.onpaste=e=>{const selected=[...(e.clipboardData?.items||[])].filter(i=>i.kind==='file').map(i=>i.getAsFile()).filter(Boolean);if(selected.length){e.preventDefault();select(selected);}};
      upload.onclick=async()=>{if(uploading)return;uploading=true;input.disabled=true;renderQueue();message.textContent='正在上传…';
        try{while(files.length){const file=files[0],result=await api('/items/'+item.id+'/files?filename='+encodeURIComponent(file.name),'POST',file,true);stored=result.item.files;files.shift();showImages(stored);renderQueue();}message.textContent='截图已上传。';}
        catch(e){message.textContent=e.message+' 已上传的截图已保存；可删除待传截图后重试。';}
        finally{uploading=false;input.disabled=stored.length>=maxImages;renderQueue();await list();}};
      section.append(label,queue,upload,message);
    }
    section.append(node('h3','评论'));if(!item.comments.length)section.append(node('p','暂无评论。','muted'));
    item.comments.forEach(comment=>{const box=node('div',undefined,'comment');box.append(node('div',comment.by.name+' · '+date(comment.at),'muted'),node('p',comment.text,'text'));section.append(box);});
    const form=node('form'),label=node('label','追加评论'),area=node('textarea'),button=node('button','发送评论'),message=node('p','','error');area.maxLength=4000;area.required=true;label.append(area);button.type='submit';message.setAttribute('role','status');form.append(label,button,message);
    form.onsubmit=async e=>{e.preventDefault();button.disabled=true;try{await api('/items/'+item.id+'/comments','POST',{text:area.value});area.value='';await list();await openDetail();}catch(e){message.textContent=e.message;button.disabled=false;}};
    section.append(form);
  }catch(e){if(version===detailVersion)section.replaceChildren(node('p',e.message,'error'));}
}
el('submit-form').onsubmit=async e=>{
  e.preventDefault();if(busy)return;busy=true;el('submit').disabled=true;el('screenshots').disabled=true;previews();el('submit-message').textContent='正在提交…';
  try{if(!pendingItem){pendingItem=(await api('','POST',{type:document.querySelector('input[name=type]:checked').value,title:el('title').value,body:el('body').value})).item;el('draft-fields').disabled=true;}
    while(pending.length){const file=pending[0];pendingItem=(await api('/items/'+pendingItem.id+'/files?filename='+encodeURIComponent(file.name),'POST',file,true)).item;pending.shift();previews();}
    const key=pendingItem.id;pendingItem=null;el('submit-form').reset();el('draft-fields').disabled=false;el('submit-message').textContent='提交成功。';el('submit').textContent='提交反馈';location.hash=key;await openDetail();
  }catch(e){el('submit-message').textContent=(pendingItem?'反馈 #'+pendingItem.no+' 已保存；截图未全部上传，可删除或重试。':'')+e.message;if(pendingItem)el('submit').textContent='重试上传截图';}
  finally{busy=false;el('submit').disabled=false;el('screenshots').disabled=false;previews();await list();}
};
el('scope').onclick=()=>{all=!all;list();};el('refresh').onclick=()=>{list();openDetail();};
window.addEventListener('hashchange',()=>{openDetail();el('detail').scrollIntoView({block:'start'});});
window.addEventListener('pagehide',()=>[...previewUrls,...detailUrls].forEach(url=>URL.revokeObjectURL(url)));
list();openDetail();
</script></html>`;
}
