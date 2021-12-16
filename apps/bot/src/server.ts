/* eslint-disable @typescript-eslint/ban-ts-comment */
import { Client, Collection, ColorResolvable, GuildMember, MessageActionRow, MessageButton, MessageEmbed, Snowflake, TextChannel, User } from "discord.js";
import express, { Express, Request, Response } from "express";
import getRoles from "./util/getRoles";
import cors from "cors";
import purgeCache from "./util/purgeCache";
import requestIp from "request-ip";
import fileUpload from "express-fileupload";

export const _RATE_LIMIT_TIME = 1000 * 60 * 5; // 5 minutes
// export const _RATE_LIMIT_TIME = 1000; // 1 second
export const ANSI_RESET = "\u001b[0m";

interface ServerOpts {
	port: number,
	logChannel: Snowflake
}

interface ApplicationBody {
	id: string,
	courses: string[],
}

enum LoggingLevel {
	LOG = "log",
	WARNING = "warn",
	ERROR = "error"
}

interface BugReportBody {
	title: string, 
	user: Snowflake,
	type: "LESSON_GLITCH" | "SITE_CRASH" | string;
	desc: string,
}
interface SuggestionBody {
	title: string, 
	user: Snowflake,
	desc: string,
}

const LoggerColors = new Map<LoggingLevel | string, {
	ansi: string,
	discord: ColorResolvable
}>();
LoggerColors.set(LoggingLevel.LOG, { ansi: "\u001b[34;1m", discord: "YELLOW" });
LoggerColors.set(LoggingLevel.WARNING, { ansi: "\u001b[33;1m", discord: "ORANGE" });
LoggerColors.set(LoggingLevel.ERROR, { ansi: "\u001b[31;1m", discord: "RED" });

/**
 * The server class
 */
export class Server {
	private client: Client;
	private app: Express;
	private port: number;
	private logChannel: TextChannel | null = null;
	private rateLimitIpCache = new Collection<string, number>();

	/**
	 * @constructor
	 * @param {Client} client the discord API client
	 * @param {ServerOpts} options options (port etc)
	 */
	constructor(client: Client, options: ServerOpts) {
		this.client = client;
		this.port = options.port;
		this.asyncSetup(options);
		/**
		 * Express config
		 */
		this.app = express();
	}

	private async asyncSetup(options: ServerOpts) {
		this.logChannel = await this.client.channels.fetch(options.logChannel) as TextChannel;
	}

	/**
	 * @method expressConfig the express configuration method
	 */
	public expressConfig() {
		this.app.use(cors());
		this.app.use(fileUpload({
			limits: { fileSize: 50 * 1024 * 1024 },
		}));
		this.app.use(express.json());
		this.app.use(requestIp.mw());
		this.app.post("/api/applications", this.sendEmbed);
		this.app.get("/api/roles", this.getRoles);
		this.app.post("/api/log/:level", this.logger);
		this.app.post("/feedback/bug", this.bug);
		this.app.post("/feedback/suggestion", this.suggestion);
		this.app.listen(this.port, () => {
			console.log(`REST API listening on http://localhost:${this.port}`);
		});
	}
	/**
	 * @method sendEmbed send an embed for a role application
	 * @param {Request} req the request object
	 * @param {Response} res the response object (ew)
	 */
	private sendEmbed = async (req: Request, res: Response) => {
		const guild = this.client.guilds.cache.get("877584374521008199");
		const body: ApplicationBody = req.body;
		const user = await guild?.members.fetch(body.id).catch(
			() => undefined
		);

		if (!user) return res.status(404).send("User not found. Please join the server before sending another application (programmingsimplified.org/discord)");
		this.rateLimitIpCache = purgeCache(this.rateLimitIpCache);
		// @ts-ignore
		const ip = req.clientIp;
		console.log(ip);
		if (typeof ip == "string") {
			const ipTime = this.rateLimitIpCache.get(ip);

			if (ipTime && new Date().getTime() - ipTime < _RATE_LIMIT_TIME) {
				res.status(429).send("Looks like you are sending us too many requests too quickly. Please try again in a few minutes");

				return;
			}
			this.rateLimitIpCache.set(ip, new Date().getTime());
		}

		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-ignore
		const channel: TextChannel = guild?.channels.cache.get("903888105143173150");
		const embed = await this.buildEmbed(user, body.courses, body);
		const row = this.getRow(body.id);
		channel.send({ embeds: [embed], components: [row] });

		res.send("Application Sent");
	};

	/**
	 * @method buildEmbed builds the embed for the the moderator to accept
	 * @param {GuildMember | undefined } member the guild member to build the embed for
	 * @param {string[]} courses the courses for the member to be enrolled in
	 * @returns the constructed embed
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private async buildEmbed(member: GuildMember | undefined, courses: string[], body: any): Promise<MessageEmbed> {
		const embed = new MessageEmbed()
			.setTitle("New course Application")
			.setDescription(courses.toString())
			.addFields([{ name: "User", value: `<@${member?.id}>`, inline: true }, { name: "Age", value: body.age, inline: true }, { name: "Experience", value: body.experienceDetails || "None", inline: true }, { name: "Time Dedication", value: body.timeDedication, inline: true }, { name: "Misc", value: body.misc || "None", inline: true }]);
		if (!member) {
			return embed;
		}
		const coursesWithNames = await Promise.all(courses.map(async (course) => {
			const role = (await getRoles(this.client)).find(i => i.id == course);
			return { name: role?.name, value: course, inline: true };
		}));
		embed
			.setThumbnail(member?.user?.avatarURL() ?? "")
			.addField("Courses", coursesWithNames.map(i => i.name).join("\n"));

		return embed;
	}

	/**
	 * @method getRow get the MessageActionRow to add to the embed.
	 * @param {string} id the id of the user
	 * @param {string[]} courses the array of course names
	 * @returns the MessageActionRow to add to the embed
	 */
	private getRow(id: Snowflake): MessageActionRow {
		const accept = new MessageButton()
			.setLabel("Accept")
			.setCustomId(`accept_${id}`)
			.setStyle("SUCCESS")
			.setEmoji("889310059501342751");

		const reject = new MessageButton()
			.setLabel("Reject")
			.setCustomId(`reject_${id}`)
			.setStyle("DANGER")
			.setEmoji("889310059975311380");
		return new MessageActionRow()
			.addComponents(accept, reject);
	}

	/**
	 * @method getRoles the route to get the collection of student roles.
	 * @param {Request} _ the request object, discarded
	 * @param {Response} res the response object to send the information to
	 */
	private getRoles = async (_: Request, res: Response) => {
		res.send(JSON.stringify(await getRoles(this.client), (_key, value) =>
			typeof value === "bigint" ? value.toString() : value
		)
		);
	};

	private logger = (req: Request<{ level: LoggingLevel }, unknown, { message: string, data: unknown }>, res: Response) => {
		const colors = LoggerColors.get(req.params.level) ?? { discord: "LUMINOUS_VIVID_PINK", ansi: "" };

		// Construct the logging embed
		const logEmbed: MessageEmbed = new MessageEmbed()
			.setTitle(req.params.level)
			.setDescription(`${req.params.level}: ${req.body.message}\n\`\`\`json\n${JSON.stringify(req.body.data)}\n\`\`\``)
			.setColor(colors.discord);
		// Send the embed
		this.logChannel?.send({ embeds: [logEmbed] });

		// Log to console
		console.log(`${colors.ansi}${req.params.level}:${ANSI_RESET} ${req.body.message}\n${JSON.stringify(req.body.data)}`);

		// prevent request from timing out
		res.send("SUCCESS");
	}

	private bug = async (req: Request<unknown, unknown, BugReportBody>, res: Response) => {
		let user: User;
		try {
			user = await this.client.users.fetch(req.body.user);
		} catch (error) {
			return res.send("ERROR: USER NOT FOUND");
		}
		const embed = new MessageEmbed()
			.setThumbnail(user.displayAvatarURL())
			.setAuthor(user.username, user.displayAvatarURL())
			.setTitle(`${req.body.type}: ${req.body.title} (${user.tag})`)
			.setDescription(req.body.desc);

		this.logChannel?.send({ embeds: [embed]});
		res.send("SUCCESS");
	}

	private suggestion = async (req: Request<unknown, unknown, SuggestionBody>, res: Response) => {
		let user: User;
		try {
			user = await this.client.users.fetch(req.body.user);
		} catch (error) {
			return res.send("ERROR: USER NOT FOUND");
		}
		const embed = new MessageEmbed()
			.setThumbnail(user.displayAvatarURL())
			.setAuthor(user.username, user.displayAvatarURL())
			.setTitle(`Suggestion: ${req.body.title} (${user.tag})`)
			.setDescription(req.body.desc);
		
		
		
		this.logChannel?.send({ embeds: [embed]});
		res.send("SUCCESS");
	}
}
