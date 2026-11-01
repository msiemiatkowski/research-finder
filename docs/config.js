/* Settings of this copy of Research Finder.
   googleClientId: the OAuth client ID (type "Web application") of a Google Cloud project, with this site's address
   as an authorised JavaScript origin. It is public by design: it names the app, it is not a password. Without it,
   everything works except saving to Google Drive. See "Saving to Google Drive" in README.md.
   creator: shown under About; leave the name empty to show nothing. */
export const CONFIG = {
  googleClientId: "780056234403-375dlmv421s2oc6qqs4b7nu7au7dfinc.apps.googleusercontent.com",
  creator: {
    name: "Maciej Siemiątkowski",
    role: "researcher",
    affiliation: "Faculty of Psychology, University of Warsaw",
    bio: "I built Research Finder for my own work. Searching for papers is easy; finding the datasets behind them, " +
      "finding research written in other languages, and keeping everything a search turns up in one place that I can " +
      "come back to, share and report is not. Research Finder does those three things, and I made it free for anyone " +
      "who needs the same.",
    email: "maciej.siemiatkowski@psych.uw.edu.pl",
  },
};
