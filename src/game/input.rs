//! Reading client input from the lock-free slots, and emotes.

use crate::protocol;

use super::player::{AOI_MAX, OPPOSITE};
use super::{EMOTE_COOLDOWN_TICKS, World};

impl World {
    /// Copies each client's latest input from its lock-free slot.
    pub(super) fn read_inputs(&mut self) {
        let tick = self.tick;
        for p in self.players.values_mut() {
            let Some(link) = &p.link else { continue };
            let (d, s, jump, seq) = link.input.dirs();
            let (pd, ps, _, pseq) = link.input.prev_dirs();
            p.input_jump = jump;
            let reversed = p.reversed_until > tick;
            let turn = |d: u8| if reversed { OPPOSITE[d as usize] } else { d };
            (p.input_dir, p.input_alt, p.input_seq) = (turn(d), turn(s), seq);
            p.prev_input = (turn(pd), turn(ps), pseq);
            let presses = link.input.bomb_presses();
            if presses != p.bomb_presses {
                p.bomb_presses = presses;
                p.want_bomb = true;
            }
            let gadgets = link.input.gadget_presses();
            if gadgets != p.gadget_presses {
                p.gadget_presses = gadgets;
                p.want_gadget = true;
            }
            p.input_detach = link.input.detach_held();
            let abilities = link.input.ability_presses();
            if abilities != p.ability_presses {
                p.ability_presses = abilities;
                p.want_ability = true;
            }
            let cancels = link.input.cancel_presses();
            if cancels != p.cancel_presses {
                p.cancel_presses = cancels;
                p.want_cancel = true;
            }
            let acts = link.input.act_presses();
            if acts != p.act_presses {
                p.act_presses = acts;
                p.want_act = true;
            }
            let (count, e) = link.input.latest_emote();
            if count != p.emote_seq {
                p.emote_seq = count;
                if tick >= p.next_emote_at {
                    p.next_emote_at = tick + EMOTE_COOLDOWN_TICKS;
                    self.scratch.emotes.push((p.id, e));
                }
            }
            p.snap_ack = link.input.ack();
            if let Some((w, h)) = link.input.view() {
                p.set_aoi(w, h);
            }
        }
    }

    /// Shows queued emotes to the players near each emitter.
    pub(super) fn send_emotes(&mut self) {
        let mut emotes = std::mem::take(&mut self.scratch.emotes);
        for &(id, e) in &emotes {
            let Some(p) = self.players.get(&id) else { continue };
            let msg = protocol::encode_emote(self.event_arenas.current(), id, e);
            let (cx, cy) = p.cell();
            let (hw, hh) = AOI_MAX;
            for o in self.players_in_rect(cx - hw, cy - hh, cx + hw, cy + hh) {
                if let Some(link) = &o.link {
                    let _ = link.events.try_send(msg.clone());
                }
            }
        }
        emotes.clear();
        self.scratch.emotes = emotes;
    }
}
