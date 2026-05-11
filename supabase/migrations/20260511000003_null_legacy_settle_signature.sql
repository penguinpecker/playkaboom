-- 2026-05-11 cleanup: revert auto-paired settle_signature on the 17 legacy
-- corrupted rows from the GameSettled indexer race. Today's deploy of
-- idx_apply_game_settled retroactively paired some of these orphan cashouts
-- to LATER game-instance settle events (same PDA, different round). The
-- verifier now cross-checks game PDA equality so the false VERIFIED is
-- already gone — but to keep the user's intent ("don't backfill, leave
-- legacy rows as-is for record"), null out the auto-paired pointers so
-- those rows uniformly show PENDING.
--
-- This is a one-shot data fix, not a schema change. After this runs every
-- one of the 17 listed signatures will have settle_signature = NULL and the
-- verifier will display "settle pending" instead of any data.

UPDATE public.games
SET settle_signature = NULL
WHERE signature IN (
  'bNjim2GobihcW2fCBs1QiiuWKYoAZb8y3kGcDcBbpTjSJPTMpPoZe6fxdMwP6DGBozDYb4o7QF5avhfDq5CmBes',
  '5gwtS1hXjdcEgfviZnvJ7G2k9r5Z7pPQxxHmjvUjo2TTibiv6ZRkwYouoHweF7GEkReP34vryYndypE3EH2yDRAR',
  '49dRZgMt6A3wmWCWcuj5BeYMtVfWRT1wkh4P2XBwY6V1NJ4GZ1DVu7YYVffWRS9BG4UudK4gsZvLwoqtCpKeh1Xp',
  'YyZKftgtbTdZsAK7qKBc4kxeKJ4a5daYzYACxdwZJGNpZzfJx9EnwdqAFRbn5ZrWkpmMng9RaanKCB29paMPhBS',
  '2aKKXapixZqjUDCxcs6THT2h2oUsc5ZuVDnx64z9ezHuXJvz2gRJhPAfgLo7htinh7GbNdzZaNcwGXKZTxyz8gKQ',
  '3cpeaYxjR49v2hbHuqLTZnAyucQkgUGwTQZ2HTiEPWoWeoxMChXZar53t94nudvGe75fPf3HpfA3yrV3HdC35g9Z',
  '2GaVJjfe1s9XekPeQBDiZFLoY9nvcGrsdzU9jD9nh4x2TZeE9FvwD23k7f1m6miqGGxFPZffr8kzZTMZ5nPeCVEU',
  'eSPy81ZWPMxoC8QjsD9mXC6TQWmurDmvXnXzXDpCi6gM4W57daqfKdyMAZkkvshJ1Tqbcw7VvLdXrG7x8VbYiaC',
  '2yYceRe6swNRWVcepHyr5wFewk24p3V25cwnWYbDTf6n3HENBf7FVeXTkupzaNkj3uFwXgByjxvzVwbatn1tHim',
  '2zbxzoWtpj1fLxtYhYog6wduJTSGc2mM39Xaj7AWY7CPtS7wRvzbhS3uyw8gMuW4CEqwDCxxEHv2HQjjpTnWwRUj',
  '6527biE3XrG1Go8YyPWiQpTkX55kHdMPziqZytH5FpQiBrdjXQgh7wJJMDYt1KubfD1ntS4PaoLJq5QkEYFbiWii',
  '2wE1v9fmku8bmevqHKHG2LxXqujabWfCrMb1CnUS9eoTsF3B5V7KC3oekjFTKiR39EsM4FNpGtNK7s2LnjVfheCw',
  '3HEmSFWfkHp1ieHPGNmy8c6Mk6uA8MuUQR9ke1VpcFeZc17UpFTtiLAsmSnXckEzpXuGy1eQwtzkaQaEbtgFBhpz',
  'JfvMmDgWvBA5hHKrkoSyMABAUWmVE5XLN385o8TWpnYbAbFoK2DKDB6y29gYchgbjkLdEHPyLpL1ayXGE2mmrEt',
  '2epw7gKccPcBnk35hKcd4PAsKVWzPFaPwTKgHbeaiHAuhrjrhhwkaEtqC8fZepxWnWNzTPqwgqcPpFtmkNudgAhR',
  '4q4TY4y5NARb7L7gXKNiTFUxdYANQcJ5c7dNoLpRxN1pwJAhTtpgWAm3RerWF7f4P7zjq9JTFPP83a4FyegoGCH9',
  '4Doe8vfDPcpM4hr9FGTHMcRACAaS91Nvzt6yA1MGitAYnALE34tatqFHJZRLE5DRzFYzwPdQxR7yoz9oMnmhjgh'
);
