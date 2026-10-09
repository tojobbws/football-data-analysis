# Outcome distribution is stored with the pick but kept out of record_hash

Fan pages show a pick's outcome distribution (ถูก / เสมอตัว / ผิด …) because the single fair probability (pushes left out) reads as "the chance the win condition happens" and overstates it — Bremen +2 showed 68% while the model's chance of ถูก was 54%. We store the distribution on `analysis_predictions.model_distribution`, freeze it after publish with the update trigger, and backfill existing picks from their candidate, but deliberately leave it out of `fp_prediction_canonical`, so every existing `record_hash` and `fp_verify_prediction_chain()` stay valid.

## Considered Options

- **Read it from `analysis_candidates` at display time**: no migration, but candidates are not public and not frozen.
- **Hash it too (versioned canonical, key only when non-null)**: full proof for new picks, at the cost of a second canonical shape in the chain forever. Rejected for now: the distribution is a by-product of the hashed `model_probability` (its fair probability must equal it), so tampering would be detectable anyway. Revisit if the distribution ever carries information the hashed fields don't pin down.
