using System;
using System.IO;
using System.Speech.Synthesis;
using System.Text;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length < 2) throw new ArgumentException("usage: ai-player-voice <utf16-text-file> <wav-output> [rate]");
            string text = File.ReadAllText(args[0], Encoding.Unicode).TrimStart('\uFEFF');
            if (String.IsNullOrWhiteSpace(text)) throw new ArgumentException("narration is empty");
            int rate = args.Length >= 3 ? Math.Max(-5, Math.Min(5, Int32.Parse(args[2]))) : 0;
            using (var voice = new SpeechSynthesizer())
            {
                voice.Rate = rate;
                voice.Volume = 100;
                voice.SetOutputToWaveFile(args[1]);
                voice.Speak(text);
            }
            return File.Exists(args[1]) && new FileInfo(args[1]).Length > 1000 ? 0 : 2;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
