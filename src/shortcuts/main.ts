import {invoke} from "@tauri-apps/api/core";
import "./style.css";
type Settings={bindings:Record<string,string>;defaults:Record<string,string>;unavailable:string[]};
const labels:Record<string,string>={pause:"暂停",resume:"继续",toggle:"切换暂停 / 继续",hide:"隐藏桌面生物",save:"立即保存"};
const keys=[...Array.from({length:12},(_,i)=>"F"+(i+1)),..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"];
const root=document.querySelector<HTMLDivElement>("#bindings")!,status=document.querySelector<HTMLParagraphElement>("#status")!,form=document.querySelector<HTMLFormElement>("#settings")!;
let settings:Settings;
function render(bindings:Record<string,string>):void{
 root.replaceChildren();
 for(const [id,label] of Object.entries(labels)){
  const row=document.createElement("fieldset"),legend=document.createElement("legend");legend.textContent=label;row.dataset.action=id;row.append(legend);
  const parts=(bindings[id]??"").split("+"),enabled=!!bindings[id];
  for(const [value,text] of [["enabled","启用"],["Ctrl","Ctrl"],["Alt","Alt"],["Shift","Shift"]]){const wrapper=document.createElement("label"),input=document.createElement("input");input.type="checkbox";input.value=value;input.checked=value==="enabled"?enabled:parts.includes(value);input.setAttribute("aria-label",label+" "+text);wrapper.append(input,document.createTextNode(text));row.append(wrapper);}
  const select=document.createElement("select");select.setAttribute("aria-label",label+" 按键");for(const key of keys){const option=document.createElement("option");option.value=key;option.textContent=key;select.append(option);}select.value=parts[parts.length-1]||"F9";row.append(select);
  const update=():void=>{const active=row.querySelector<HTMLInputElement>('input[value="enabled"]')!.checked;for(const input of row.querySelectorAll<HTMLInputElement|HTMLSelectElement>('select,input:not([value="enabled"])'))input.disabled=!active;};row.querySelector('input[value="enabled"]')!.addEventListener("change",update);update();root.append(row);
 }
}
function collect():Record<string,string>{return Object.fromEntries(Array.from(root.querySelectorAll("fieldset")).map(row=>{const enabled=row.querySelector<HTMLInputElement>('input[value="enabled"]')!.checked;const modifiers=Array.from(row.querySelectorAll<HTMLInputElement>('input:checked:not([value="enabled"])')).map(i=>i.value);return [row.dataset.action!,enabled?[...modifiers,row.querySelector("select")!.value].join("+"):""];}));}
function busy(value:boolean):void{for(const button of form.querySelectorAll<HTMLButtonElement>("button"))button.disabled=value;}
form.addEventListener("submit",event=>{event.preventDefault();busy(true);status.textContent="正在应用…";status.className="";void invoke<Settings>("save_shortcut_settings",{bindings:collect()}).then(value=>{settings=value;render(value.bindings);status.textContent="已保存并生效，下次启动会保留这些设置。";status.className="success";}).catch(error=>{status.textContent=String(error);status.className="error";}).finally(()=>busy(false));});
document.querySelector("#reset")!.addEventListener("click",()=>{render(settings.defaults);status.textContent="已填入默认组合，点击保存后生效。";status.className="";});
busy(true);void invoke<Settings>("get_shortcut_settings").then(value=>{settings=value;render(value.bindings);status.textContent=value.unavailable.length?"当前未注册成功："+value.unavailable.join("、")+"。可以更换组合后保存。":"设置保存在本机，与游戏存档独立。";busy(false);}).catch(error=>{status.textContent="无法读取设置："+String(error);status.className="error";});
