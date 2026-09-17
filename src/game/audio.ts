export type GameSound = "open" | "close" | "garbage" | "egg" | "roach";
export class GameAudio {
  enabled=true;
  private readonly sounds=new Map<GameSound,HTMLAudioElement>();
  private last=0;
  play(name:GameSound):void {
    const now=performance.now();if(!this.enabled || now-this.last<90)return;this.last=now;
    let sound=this.sounds.get(name);if(!sound){sound=new Audio(`/game/props/${name}.wav`);sound.volume=.32;this.sounds.set(name,sound);}
    sound.currentTime=0;void sound.play().catch(()=>undefined);
  }
}
