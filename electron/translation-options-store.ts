import {mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isPanelTarget,type PanelTarget} from '../src/shared/workbench';

export interface TranslationOptions {fallbackTarget:PanelTarget}
export interface TranslationOptionsStore {load():Promise<TranslationOptions>;save(options:TranslationOptions):Promise<void>}
export function isTranslationOptions(value:unknown):value is TranslationOptions {
  return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).join(',')==='fallbackTarget'&&isPanelTarget((value as TranslationOptions).fallbackTarget);
}
/** Only an explicit fallback preference is durable. Conversation text and inferred targets never enter this file. */
export class FileTranslationOptionsStore implements TranslationOptionsStore {
  private queue:Promise<void>=Promise.resolve();
  constructor(private path:string){}
  async load():Promise<TranslationOptions>{
    let text:string;try{text=await readFile(this.path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{fallbackTarget:'en'};throw new Error('TRANSLATION_OPTIONS_READ_FAILED');}
    try{if(text.length>256)throw new Error();const value:unknown=JSON.parse(text);if(!isTranslationOptions(value))throw new Error();return{fallbackTarget:value.fallbackTarget};}catch{throw new Error('TRANSLATION_OPTIONS_INVALID');}
  }
  save(options:TranslationOptions):Promise<void>{
    if(!isTranslationOptions(options))return Promise.reject(new Error('INVALID_FALLBACK_TARGET'));
    const value={fallbackTarget:options.fallbackTarget};
    const task=this.queue.then(async()=>{const temporary=this.path+'.'+randomUUID()+'.tmp';try{await mkdir(dirname(this.path),{recursive:true});await writeFile(temporary,JSON.stringify(value)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});await rename(temporary,this.path);}catch{throw new Error('TRANSLATION_OPTIONS_SAVE_FAILED');}finally{await unlink(temporary).catch(()=>{});}});
    this.queue=task.catch(()=>{});return task;
  }
}
