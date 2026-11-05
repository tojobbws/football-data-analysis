-- Rolls back 0054: drops the votes of the Hybrid AI majority of three (the decisions themselves stay).
alter table hybrid_decisions drop column if exists votes;
