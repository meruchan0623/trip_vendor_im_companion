using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Windows.Automation;

internal static partial class Program
{
    sealed record DraftBounds(int X, int Y, int Width, int Height);
    sealed record DraftSnapshot(string TargetInstanceId, string EditorIdentity, string Text, string Revision, DraftBounds Bounds, bool CanReplace);
    sealed record CapturedDraft(AutomationElement Element, ValuePattern? Value, DraftSnapshot Snapshot);
    static int draftBusy;

    static async void DraftCommand(string requestId)
    {
        if (!StillBound()) { Error(requestId, "target_not_bound"); return; }
        if (Interlocked.Exchange(ref draftBusy, 1) != 0) { Error(requestId, "draft_busy"); return; }
        nint handle = target; string expectedInstance = instance!; long expectedGeneration = generation;
        long deadline = Environment.TickCount64 + 3500;
        // UIA providers can block. Keep those calls off the WinEvent/message-loop thread.
        // A timed-out read can finish harmlessly. This fallback never writes a merchant draft.
        var task = Task.Run(() =>
        {
            var current = CaptureDraft(handle, expectedInstance, expectedGeneration, deadline);
            return current.Snapshot;
        });
        try
        {
            if (await Task.WhenAny(task, Task.Delay(4500)) != task) { Error(requestId, "draft_access_timeout"); return; }
            var result = await task;
            if (generation != expectedGeneration || instance != expectedInstance) { Error(requestId, "draft_expired"); return; }
            Emit("draft", result, requestId);
        }
        catch (Exception error)
        {
            string code = error is InvalidOperationException && System.Text.RegularExpressions.Regex.IsMatch(error.Message, "^[a-z_]+$") ? error.Message : "composer_accessibility_unavailable";
            Error(requestId, code);
        }
        finally { if (task.IsCompleted) Interlocked.Exchange(ref draftBusy, 0); else _ = task.ContinueWith(_ => Interlocked.Exchange(ref draftBusy, 0)); }
    }

    static CapturedDraft CaptureDraft(nint handle, string expectedInstance, long expectedGeneration, long deadline)
    {
        if (!Native.GetWindowRect(handle, out var window) || Native.IsIconic(handle) || !Native.IsWindowVisible(handle)) throw new InvalidOperationException("target_not_visible");
        var root = AutomationElement.FromHandle(handle);
        var queue = new Queue<AutomationElement>(); queue.Enqueue(root);
        var candidates = new List<AutomationElement>();
        var context = new StringBuilder();
        int nodes = 0;
        double windowWidth = window.Right - window.Left, windowHeight = window.Bottom - window.Top;
        while (queue.Count > 0)
        {
            if (++nodes > 1200 || Environment.TickCount64 >= deadline) throw new InvalidOperationException("composer_tree_unverified");
            var node = queue.Dequeue(); var info = node.Current; var box = info.BoundingRectangle;
            if (info.IsPassword) continue;
            bool composer = info.ControlType == ControlType.Edit && info.IsEnabled && !info.IsOffscreen
                && box.Width >= Math.Max(150, windowWidth * .18) && box.Height >= 25
                && box.Left >= window.Left + windowWidth * .16 && box.Right <= window.Right
                && box.Top >= window.Top + windowHeight * .48 && box.Bottom <= window.Bottom;
            if (composer) { candidates.Add(node); continue; }
            // Hash accessible context above the composing region. Customer/conversation switches
            // invalidate a review even if a recycled edit element happens to contain the same text.
            if (!info.IsOffscreen && info.ControlType != ControlType.Edit && box.Top < window.Top + windowHeight * .48 && !string.IsNullOrWhiteSpace(info.Name))
                context.Append(info.ControlType.Id).Append(':').Append(info.Name).Append('\n');
            var child = TreeWalker.ControlViewWalker.GetFirstChild(node);
            while (child != null)
            {
                if (queue.Count + nodes >= 1200 || Environment.TickCount64 >= deadline) throw new InvalidOperationException("composer_tree_unverified");
                queue.Enqueue(child); child = TreeWalker.ControlViewWalker.GetNextSibling(child);
            }
        }
        if (candidates.Count != 1) throw new InvalidOperationException(candidates.Count == 0 ? "composer_accessibility_unavailable" : "composer_ambiguous");
        if (context.Length < 2) throw new InvalidOperationException("conversation_context_unavailable");
        var editor = candidates[0];
        ValuePattern? value = null;
        string text;
        if (editor.TryGetCurrentPattern(ValuePattern.Pattern, out var pattern)) { value = (ValuePattern)pattern; text = value.Current.Value; }
        else if (editor.TryGetCurrentPattern(TextPattern.Pattern, out var readable)) text = ((TextPattern)readable).DocumentRange.GetText(20001).TrimEnd('\r');
        else throw new InvalidOperationException("composer_text_unavailable");
        text = text.Replace("\r\n", "\n");
        if (text.Length > 20000 || text.Contains('\0')) throw new InvalidOperationException("composer_text_too_large");
        string editorId = string.Join('.', editor.GetRuntimeId());
        var rectangle = editor.Current.BoundingRectangle;
        var bounds = new DraftBounds((int)rectangle.X, (int)rectangle.Y, (int)rectangle.Width, (int)rectangle.Height);
        string revision = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { expectedInstance, expectedGeneration, editorId, text, context = context.ToString() }))));
        return new CapturedDraft(editor, value, new DraftSnapshot(expectedInstance, editorId, text, revision, bounds, false));
    }
}
