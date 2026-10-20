using System.Text.RegularExpressions;

namespace TripVendorInstaller;

/// <summary>Conservative release version comparison shared by transaction and display policy.</summary>
public static class InstallerVersions {
    public static string? KnownVersion(string? value) {
        var candidate=value?.Split('+')[0];
        return candidate!=null&&Regex.IsMatch(candidate,@"^\d+\.\d+\.\d+(?:\.\d+)?$",RegexOptions.CultureInvariant)&&Version.TryParse(candidate,out _)?candidate:null;
    }
    static Version? Comparable(string? value){var known=KnownVersion(value);if(known==null)return null;var version=Version.Parse(known);return new(version.Major,version.Minor,version.Build,Math.Max(version.Revision,0));}
    public static bool TryCompare(string? left,string? right,out int comparison){var a=Comparable(left);var b=Comparable(right);comparison=0;if(a==null||b==null)return false;comparison=a.CompareTo(b);return true;}
}
