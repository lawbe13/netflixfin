namespace Jellyfin.Plugin.NetflixFin.Awards;

/// <summary>
/// Award tallies for one title, keyed elsewhere by IMDb ID.
/// </summary>
/// <remarks>
/// Wins and nominations are independent counts, not a superset of one another: on films a
/// win is usually also recorded as a nomination, on television it frequently is not. Never
/// add them together.
/// </remarks>
public sealed class AwardRecord
{
    /// <summary>Gets or sets the number of Academy Awards won.</summary>
    public int OscarWins { get; set; }

    /// <summary>Gets or sets the number of Academy Award nominations.</summary>
    public int OscarNoms { get; set; }

    /// <summary>Gets or sets the number of Primetime Emmy Awards won.</summary>
    public int EmmyWins { get; set; }

    /// <summary>Gets or sets the number of Primetime Emmy nominations.</summary>
    public int EmmyNoms { get; set; }

    /// <summary>Gets or sets the number of Golden Globes won.</summary>
    public int GlobeWins { get; set; }

    /// <summary>Gets or sets the number of Golden Globe nominations.</summary>
    public int GlobeNoms { get; set; }

    /// <summary>Gets or sets the number of BAFTA Film Awards won.</summary>
    public int BaftaWins { get; set; }

    /// <summary>Gets or sets the number of BAFTA Film Award nominations.</summary>
    public int BaftaNoms { get; set; }

    /// <summary>Gets a value indicating whether the record carries anything worth showing.</summary>
    public bool IsEmpty =>
        OscarWins == 0 && OscarNoms == 0 &&
        EmmyWins == 0 && EmmyNoms == 0 &&
        GlobeWins == 0 && GlobeNoms == 0 &&
        BaftaWins == 0 && BaftaNoms == 0;

    /// <summary>
    /// Folds another record in, keeping the larger count per family.
    /// </summary>
    /// <remarks>
    /// The two sources disagree by omission rather than by contradiction. Wikidata is
    /// complete on film awards and sparse on television; OMDb's headline clause is
    /// IMDb-derived and exact, but names only one award family per title, so its silence
    /// about the others means nothing. Taking the maximum keeps whichever source actually
    /// knew about a given family.
    /// </remarks>
    /// <param name="other">The record to fold in.</param>
    public void Merge(AwardRecord other)
    {
        OscarWins = Math.Max(OscarWins, other.OscarWins);
        OscarNoms = Math.Max(OscarNoms, other.OscarNoms);
        EmmyWins = Math.Max(EmmyWins, other.EmmyWins);
        EmmyNoms = Math.Max(EmmyNoms, other.EmmyNoms);
        GlobeWins = Math.Max(GlobeWins, other.GlobeWins);
        GlobeNoms = Math.Max(GlobeNoms, other.GlobeNoms);
        BaftaWins = Math.Max(BaftaWins, other.BaftaWins);
        BaftaNoms = Math.Max(BaftaNoms, other.BaftaNoms);
    }
}
