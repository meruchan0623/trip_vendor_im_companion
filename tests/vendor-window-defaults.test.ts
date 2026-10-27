import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {join} from 'node:path';

type Bootstrap={maximizeMainWindowOnOpen:(app:EventEmitter,options?:{defer?:(run:()=>void)=>void})=>()=>void};
const load=(name:string)=>createRequire(import.meta.url)(join(process.cwd(),'scripts/lib',name)) as Bootstrap;
const bootstraps={win32:load('windows-vendor-bootstrap.cjs'),darwin:load('macos-vendor-bootstrap.cjs')};

class FakeWindow extends EventEmitter{
  maximized=0;visible=true;destroyed=false;max=false;full=false;min=false;maximizable=true;resizable=true;
  constructor(readonly title:string){super();}
  getTitle(){return this.title;}
  isDestroyed(){return this.destroyed;}
  isVisible(){return this.visible;}
  isMaximized(){return this.max;}
  isFullScreen(){return this.full;}
  isMinimized(){return this.min;}
  isMaximizable(){return this.maximizable;}
  isResizable(){return this.resizable;}
  maximize(){this.maximized++;this.max=true;this.visible=true;}
}
function harness(bootstrap:Bootstrap){
  const app=new EventEmitter(),deferred:(()=>void)[]=[];
  const dispose=bootstrap.maximizeMainWindowOnOpen(app,{defer:run=>{deferred.push(run);}});
  const open=(win:FakeWindow)=>{app.emit('browser-window-created',{},win);return win;};
  const flush=()=>{for(const run of deferred.splice(0))run();};
  return {app,open,flush,dispose};
}

for(const [platform,bootstrap] of Object.entries(bootstraps)){
  test(`${platform}: the vendor main window maximizes once after its constructor finishes`,()=>{
    const {open,flush}=harness(bootstrap);
    const main=open(new FakeWindow('Main window')),other=open(new FakeWindow('IM'));
    assert.equal(main.maximized,0,'never inside the vendor constructor');
    flush();
    assert.equal(main.maximized,1);assert.equal(other.maximized,0);
    // A later restore by the user stays restored: nothing listens for later resizes or shows.
    main.max=false;main.emit('show');main.emit('restore');flush();
    assert.equal(main.maximized,1);
  });

  test(`${platform}: a hidden start waits for the vendor's own first show`,()=>{
    const {open,flush}=harness(bootstrap);
    const main=new FakeWindow('Main window');main.visible=false;open(main);flush();
    assert.equal(main.maximized,0,'maximize() would show the hidden window');
    main.visible=true;main.emit('show');assert.equal(main.maximized,1);
    main.max=false;main.emit('show');assert.equal(main.maximized,1,'only the first show');
  });

  test(`${platform}: user or vendor window states are never overridden`,()=>{
    for(const state of ['max','full','min','destroyed'] as const){
      const {open,flush}=harness(bootstrap);const main=new FakeWindow('Main window');main[state]=true;open(main);flush();
      assert.equal(main.maximized,0,state);
    }
    for(const capability of ['maximizable','resizable'] as const){
      const {open,flush}=harness(bootstrap);const main=new FakeWindow('Main window');main[capability]=false;open(main);flush();
      assert.equal(main.maximized,0,capability);
    }
  });

  test(`${platform}: window API failures and disposal never block the vendor`,()=>{
    const {open,flush,dispose,app}=harness(bootstrap);
    const broken=new FakeWindow('Main window');broken.maximize=()=>{throw Error('WINDOW_GONE');};
    open(broken);assert.doesNotThrow(flush);
    const untitled=new FakeWindow('Main window');untitled.getTitle=()=>{throw Error('WINDOW_GONE');};
    assert.doesNotThrow(()=>open(untitled));
    dispose();assert.equal(app.listenerCount('browser-window-created'),0);
    const late=open(new FakeWindow('Main window'));flush();assert.equal(late.maximized,0);
  });
}

test('Windows and macOS bootstraps keep the same startup window preference',()=>{
  assert.equal(bootstraps.win32.maximizeMainWindowOnOpen.toString(),bootstraps.darwin.maximizeMainWindowOnOpen.toString());
});
